use spaas_metering::MeteringLedger;
use spaas_persistence::{AuditRecord, DurableStorage, WalEvent};
use spaas_protocol::job::{JobLease, JobRecord};
use spaas_protocol::node::NodeRecord;
use spaas_protocol::rpc::JobDispatchMessage;
use spaas_scheduler_core::EdgeScheduler;
use spaas_security::keys::KeyPair;
use spaas_telemetry::MetricsRegistry;
use spaas_verification::VerificationEngine;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::info;
use uuid::Uuid;

#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct PairingTokenData {
    pub pairing_code: String,
    pub token: String,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    pub used: bool,
    pub device_type: Option<spaas_protocol::node::NodeDeviceType>,
}

#[derive(Clone)]
pub struct AppState {
    pub storage: Arc<DurableStorage>,
    pub nodes: Arc<RwLock<HashMap<Uuid, NodeRecord>>>,
    pub jobs: Arc<RwLock<HashMap<Uuid, JobRecord>>>,
    pub dispatches: Arc<RwLock<HashMap<Uuid, JobDispatchMessage>>>,
    pub wasm_artifacts: Arc<RwLock<HashMap<String, Vec<u8>>>>,
    pub scheduler: Arc<EdgeScheduler>,
    pub verification: Arc<VerificationEngine>,
    pub ledger: Arc<RwLock<MeteringLedger>>,
    pub metrics: Arc<MetricsRegistry>,
    pub server_keypair: Arc<KeyPair>,
    pub audit_log: Arc<RwLock<Vec<AuditRecord>>>,
    pub pairing_tokens: Arc<RwLock<HashMap<String, PairingTokenData>>>,
    pub scheduler_decisions:
        Arc<RwLock<HashMap<Uuid, spaas_protocol::workload::SchedulerDecision>>>,
    pub event_bus: tokio::sync::broadcast::Sender<String>,
    pub is_simulation_active: Arc<std::sync::atomic::AtomicBool>,
    pub pending_node_commands: Arc<RwLock<HashMap<Uuid, spaas_protocol::rpc::NodeRemoteCommand>>>,
    pub started_at_ms: i64,
}

impl AppState {
    pub fn new(data_dir: impl AsRef<Path>) -> Self {
        let storage = Arc::new(DurableStorage::open(data_dir.as_ref()).unwrap_or_else(|e| {
            panic!(
                "Failed to open durable storage at {:?}: {e}",
                data_dir.as_ref()
            )
        }));

        let recovered = storage.initial_state.clone();

        info!(
            recovered_nodes = recovered.nodes.len(),
            recovered_jobs = recovered.jobs.len(),
            recovered_metering = recovered.metering_records.len(),
            "Durable state loaded into Control Plane memory"
        );

        let mut ledger = MeteringLedger::new();
        // Restore accounts and records into ledger
        for record in &recovered.metering_records {
            let _ = ledger.record_job_execution(
                record.job_id,
                record.node_id,
                &record.idempotency_key,
                &record.provider_public_key,
                &record.submitter_public_key,
                record.usage.clone(),
                record.is_verified,
            );
        }

        let (event_bus, _) = tokio::sync::broadcast::channel(2048);

        let metrics = Arc::new(MetricsRegistry::new());

        // Recompute metric gauges from recovered WAL state (Sprint 2: GB-01 fix)
        {
            let node_states = recovered.nodes.values().map(|n| {
                let is_dead = n.state == spaas_protocol::node::NodeState::Offline
                    || n.state == spaas_protocol::node::NodeState::Revoked
                    || n.enrollment == spaas_protocol::node::EnrollmentStatus::Revoked;
                let label = n.state.display_label();
                (is_dead, label)
            });
            let job_states = recovered.jobs.values().map(|j| match j.state {
                spaas_protocol::job::JobState::Queued => "Queued",
                spaas_protocol::job::JobState::Scheduled => "Scheduled",
                spaas_protocol::job::JobState::Running => "Running",
                spaas_protocol::job::JobState::Completed => "Completed",
                spaas_protocol::job::JobState::Failed => "Failed",
                spaas_protocol::job::JobState::TimedOut => "TimedOut",
                spaas_protocol::job::JobState::Cancelled => "Cancelled",
                _ => "Unknown",
            });
            metrics.recompute_from_recovered_state(node_states, job_states);
            info!(
                active = metrics
                    .active_nodes
                    .load(std::sync::atomic::Ordering::Relaxed),
                idle = metrics
                    .idle_nodes
                    .load(std::sync::atomic::Ordering::Relaxed),
                offline = metrics
                    .offline_nodes
                    .load(std::sync::atomic::Ordering::Relaxed),
                running = metrics
                    .running_jobs
                    .load(std::sync::atomic::Ordering::Relaxed),
                "Metric counters recomputed from recovered WAL state"
            );
        }

        let key_path = data_dir.as_ref().join("server_key.json");
        let server_keypair = if key_path.exists() {
            match std::fs::read_to_string(&key_path) {
                Ok(content) => {
                    #[derive(serde::Deserialize)]
                    struct KeyFile {
                        secret_key_hex: String,
                    }
                    match serde_json::from_str::<KeyFile>(&content) {
                        Ok(kf) => match KeyPair::from_secret_hex(&kf.secret_key_hex) {
                            Ok(kp) => {
                                info!(
                                    public_key = %kp.public_key_hex(),
                                    path = ?key_path,
                                    "Loaded persisted server Ed25519 keypair"
                                );
                                kp
                            }
                            Err(e) => {
                                tracing::warn!("Failed to parse secret key hex from {:?}: {e}. Generating new keypair.", key_path);
                                KeyPair::generate()
                            }
                        },
                        Err(e) => {
                            tracing::warn!("Failed to deserialize server key file {:?}: {e}. Generating new keypair.", key_path);
                            KeyPair::generate()
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        "Failed to read server key file {:?}: {e}. Generating new keypair.",
                        key_path
                    );
                    KeyPair::generate()
                }
            }
        } else {
            let kp = KeyPair::generate();
            let json_data = serde_json::json!({
                "public_key_hex": kp.public_key_hex(),
                "secret_key_hex": kp.secret_key_hex(),
                "created_at_utc": chrono::Utc::now().to_rfc3339(),
            });
            let _ = std::fs::create_dir_all(data_dir.as_ref());
            if let Err(e) = std::fs::write(
                &key_path,
                serde_json::to_string_pretty(&json_data).unwrap_or_default(),
            ) {
                tracing::warn!("Failed to save server keypair to {:?}: {e}", key_path);
            } else {
                info!(
                    public_key = %kp.public_key_hex(),
                    path = ?key_path,
                    "Generated and persisted fresh server Ed25519 keypair"
                );
            }
            kp
        };

        Self {
            storage,
            nodes: Arc::new(RwLock::new(recovered.nodes)),
            jobs: Arc::new(RwLock::new(recovered.jobs)),
            dispatches: Arc::new(RwLock::new(HashMap::new())),
            wasm_artifacts: Arc::new(RwLock::new(recovered.wasm_artifacts)),
            scheduler: Arc::new(EdgeScheduler::new(Default::default())),
            verification: Arc::new(VerificationEngine::new()),
            ledger: Arc::new(RwLock::new(ledger)),
            metrics,
            server_keypair: Arc::new(server_keypair),
            audit_log: Arc::new(RwLock::new(recovered.audit_log)),
            pairing_tokens: Arc::new(RwLock::new(HashMap::new())),
            scheduler_decisions: Arc::new(RwLock::new(HashMap::new())),
            event_bus,
            is_simulation_active: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            pending_node_commands: Arc::new(RwLock::new(HashMap::new())),
            started_at_ms: chrono::Utc::now().timestamp_millis(),
        }
    }

    pub fn broadcast_event(&self, event_type: &str, data: serde_json::Value) {
        let payload = serde_json::json!({
            "type": event_type,
            "timestamp_ms": chrono::Utc::now().timestamp_millis(),
            "data": data,
        });
        let _ = self.event_bus.send(payload.to_string());
    }

    pub async fn store_pairing_token(&self, token_data: PairingTokenData) {
        let mut tokens = self.pairing_tokens.write().await;
        tokens.insert(token_data.pairing_code.clone(), token_data);
    }

    pub async fn validate_and_consume_pairing_token(
        &self,
        code: &str,
    ) -> Result<PairingTokenData, String> {
        let mut tokens = self.pairing_tokens.write().await;
        let token = tokens
            .get_mut(code)
            .ok_or_else(|| "Invalid pairing code".to_string())?;
        let now = chrono::Utc::now().timestamp_millis();
        if token.used {
            return Err("Pairing code has already been used".to_string());
        }
        if now > token.expires_at_ms {
            return Err("Pairing code has expired".to_string());
        }
        token.used = true;
        Ok(token.clone())
    }

    pub async fn log_audit(&self, event_type: &str, entity_id: &str, details: &str) {
        let record = AuditRecord {
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
            event_type: event_type.to_string(),
            entity_id: entity_id.to_string(),
            details: details.to_string(),
        };
        {
            let mut log = self.audit_log.write().await;
            log.push(record.clone());
        }
        let _ = self
            .storage
            .append_event(WalEvent::AppendAudit { record })
            .await;
    }

    pub async fn upsert_node(&self, node: NodeRecord) {
        {
            let mut nodes = self.nodes.write().await;
            nodes.insert(node.node_id, node.clone());
        }
        let _ = self
            .storage
            .append_event(WalEvent::UpsertNode { node })
            .await;
    }

    pub async fn upsert_job(&self, job: JobRecord) {
        {
            let mut jobs = self.jobs.write().await;
            jobs.insert(job.job_id, job.clone());
        }
        let _ = self.storage.append_event(WalEvent::UpsertJob { job }).await;
    }

    pub async fn grant_lease(&self, lease: JobLease) {
        {
            let mut jobs = self.jobs.write().await;
            if let Some(job) = jobs.get_mut(&lease.job_id) {
                job.current_lease = Some(lease.clone());
            }
        }
        let _ = self
            .storage
            .append_event(WalEvent::GrantLease { lease })
            .await;
    }

    #[allow(dead_code)]
    pub async fn renew_lease(&self, lease: JobLease) {
        {
            let mut jobs = self.jobs.write().await;
            if let Some(job) = jobs.get_mut(&lease.job_id) {
                job.current_lease = Some(lease.clone());
            }
        }
        let _ = self
            .storage
            .append_event(WalEvent::RenewLease { lease })
            .await;
    }

    #[allow(dead_code)]
    pub async fn revoke_lease(&self, job_id: Uuid, lease_id: Uuid) {
        {
            let mut jobs = self.jobs.write().await;
            if let Some(job) = jobs.get_mut(&job_id) {
                job.current_lease = None;
            }
        }
        let _ = self
            .storage
            .append_event(WalEvent::RevokeLease { job_id, lease_id })
            .await;
    }

    pub async fn store_wasm_artifact(&self, sha256: String, bytes: Vec<u8>) {
        {
            let mut artifacts = self.wasm_artifacts.write().await;
            artifacts.insert(sha256.clone(), bytes.clone());
        }
        let _ = self
            .storage
            .append_event(WalEvent::StoreArtifact { sha256, bytes })
            .await;
    }

    pub async fn revoke_node(&self, node_id: Uuid, reason: &str) -> Result<NodeRecord, String> {
        let (updated, active_job_leases) = {
            let mut nodes = self.nodes.write().await;
            let node = nodes
                .get_mut(&node_id)
                .ok_or_else(|| "Node not found".to_string())?;
            node.enrollment = spaas_protocol::node::EnrollmentStatus::Revoked;
            node.state = spaas_protocol::node::NodeState::Offline;

            // Find any jobs with leases assigned to this revoked node
            let jobs = self.jobs.read().await;
            let mut leases_to_revoke = Vec::new();
            for (job_id, job) in jobs.iter() {
                if let Some(ref lease) = job.current_lease {
                    if lease.node_id == node_id {
                        leases_to_revoke.push((*job_id, lease.lease_id));
                    }
                }
            }
            (node.clone(), leases_to_revoke)
        };

        for (job_id, lease_id) in active_job_leases {
            self.revoke_lease(job_id, lease_id).await;
        }

        let _ = self
            .storage
            .append_event(WalEvent::UpsertNode {
                node: updated.clone(),
            })
            .await;
        self.log_audit("NODE_REVOKED", &node_id.to_string(), reason)
            .await;
        self.broadcast_event(
            "NODE_REVOKED",
            serde_json::json!({ "node_id": node_id, "reason": reason }),
        );

        Ok(updated)
    }

    pub async fn purge_simulated_nodes(&self) -> (usize, usize) {
        let purged_ids: Vec<Uuid> = {
            let nodes = self.nodes.read().await;
            nodes
                .iter()
                .filter(|(_, n)| {
                    n.is_simulated
                        || n.device_type == spaas_protocol::node::NodeDeviceType::SimulatedNode
                })
                .map(|(id, _)| *id)
                .collect()
        };

        let purged_count = purged_ids.len();
        self.is_simulation_active
            .store(false, std::sync::atomic::Ordering::SeqCst);
        {
            let mut nodes = self.nodes.write().await;
            for id in &purged_ids {
                nodes.remove(id);
            }
        }

        for id in &purged_ids {
            let _ = self
                .storage
                .append_event(WalEvent::RemoveNode { node_id: *id })
                .await;
        }

        let _ = self.storage.checkpoint_snapshot().await;

        let remaining = self.nodes.read().await.len();
        self.log_audit(
            "SIMULATED_NODES_PURGED",
            "cluster",
            &format!("Purged {purged_count} simulated nodes. Remaining physical/desktop nodes: {remaining}"),
        )
        .await;

        self.broadcast_event(
            "SIMULATED_NODES_PURGED",
            serde_json::json!({
                "purged_count": purged_count,
                "remaining_nodes": remaining,
            }),
        );

        (purged_count, remaining)
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new("./data/control-plane")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use spaas_protocol::workload::WorkloadSpec;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_app_state_crud_and_persistence() {
        let dir = tempdir().unwrap();
        let state = AppState::new(dir.path());

        // 1. Audit log
        state.log_audit("TEST_EVENT", "entity_1", "details_1").await;
        assert_eq!(state.audit_log.read().await.len(), 1);

        // 2. Upsert node
        let node_id = Uuid::new_v4();
        let node = NodeRecord {
            node_id,
            public_key: "pk_123".into(),
            device_type: spaas_protocol::node::NodeDeviceType::SimulatedNode,
            enrollment: spaas_protocol::node::EnrollmentStatus::Enrolled,
            state: spaas_protocol::node::NodeState::Idle,
            capabilities: Default::default(),
            telemetry: Default::default(),
            policy: Default::default(),
            qualification: None,
            enrolled_at_ms: 0,
            last_heartbeat_ms: 0,
            region: "us".into(),
            is_simulated: true,
        };
        state.upsert_node(node).await;
        assert_eq!(state.nodes.read().await.len(), 1);

        // 3. Upsert job
        let job = JobRecord::new(WorkloadSpec::default());
        let job_id = job.job_id;
        state.upsert_job(job).await;
        assert_eq!(state.jobs.read().await.len(), 1);

        // 4. Grant, renew, revoke lease
        let mut lease = JobLease::new(job_id, node_id, 1000);
        state.grant_lease(lease.clone()).await;
        assert!(state
            .jobs
            .read()
            .await
            .get(&job_id)
            .unwrap()
            .current_lease
            .is_some());

        lease.renew(2000);
        state.renew_lease(lease.clone()).await;
        assert_eq!(
            state
                .jobs
                .read()
                .await
                .get(&job_id)
                .unwrap()
                .current_lease
                .as_ref()
                .unwrap()
                .term,
            2
        );

        state.revoke_lease(job_id, lease.lease_id).await;
        assert!(state
            .jobs
            .read()
            .await
            .get(&job_id)
            .unwrap()
            .current_lease
            .is_none());

        // 5. Store WASM artifact
        state
            .store_wasm_artifact("sha_wasm".into(), vec![0x00, 0x61, 0x73, 0x6d])
            .await;
        assert!(state.wasm_artifacts.read().await.contains_key("sha_wasm"));
    }
}
