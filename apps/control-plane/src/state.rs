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
    pub started_at_ms: i64,
}

impl AppState {
    pub fn new(data_dir: impl AsRef<Path>) -> Self {
        let storage = Arc::new(
            DurableStorage::open(data_dir.as_ref())
                .unwrap_or_else(|e| panic!("Failed to open durable storage at {:?}: {e}", data_dir.as_ref())),
        );

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

        Self {
            storage,
            nodes: Arc::new(RwLock::new(recovered.nodes)),
            jobs: Arc::new(RwLock::new(recovered.jobs)),
            dispatches: Arc::new(RwLock::new(HashMap::new())),
            wasm_artifacts: Arc::new(RwLock::new(recovered.wasm_artifacts)),
            scheduler: Arc::new(EdgeScheduler::new(Default::default())),
            verification: Arc::new(VerificationEngine::new()),
            ledger: Arc::new(RwLock::new(ledger)),
            metrics: Arc::new(MetricsRegistry::new()),
            server_keypair: Arc::new(KeyPair::generate()),
            audit_log: Arc::new(RwLock::new(recovered.audit_log)),
            started_at_ms: chrono::Utc::now().timestamp_millis(),
        }
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
        let _ = self.storage.append_event(WalEvent::AppendAudit { record }).await;
    }

    pub async fn upsert_node(&self, node: NodeRecord) {
        {
            let mut nodes = self.nodes.write().await;
            nodes.insert(node.node_id, node.clone());
        }
        let _ = self.storage.append_event(WalEvent::UpsertNode { node }).await;
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
        let _ = self.storage.append_event(WalEvent::GrantLease { lease }).await;
    }

    #[allow(dead_code)]
    pub async fn renew_lease(&self, lease: JobLease) {
        {
            let mut jobs = self.jobs.write().await;
            if let Some(job) = jobs.get_mut(&lease.job_id) {
                job.current_lease = Some(lease.clone());
            }
        }
        let _ = self.storage.append_event(WalEvent::RenewLease { lease }).await;
    }

    #[allow(dead_code)]
    pub async fn revoke_lease(&self, job_id: Uuid, lease_id: Uuid) {
        {
            let mut jobs = self.jobs.write().await;
            if let Some(job) = jobs.get_mut(&job_id) {
                job.current_lease = None;
            }
        }
        let _ = self.storage.append_event(WalEvent::RevokeLease { job_id, lease_id }).await;
    }

    pub async fn store_wasm_artifact(&self, sha256: String, bytes: Vec<u8>) {
        {
            let mut artifacts = self.wasm_artifacts.write().await;
            artifacts.insert(sha256.clone(), bytes.clone());
        }
        let _ = self.storage.append_event(WalEvent::StoreArtifact { sha256, bytes }).await;
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new("./data/control-plane")
    }
}
