use spaas_metering::MeteringLedger;
use spaas_protocol::job::JobRecord;
use spaas_protocol::node::NodeRecord;
use spaas_protocol::rpc::JobDispatchMessage;
use spaas_scheduler_core::EdgeScheduler;
use spaas_security::keys::KeyPair;
use spaas_telemetry::MetricsRegistry;
use spaas_verification::VerificationEngine;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AuditRecord {
    pub timestamp_ms: i64,
    pub event_type: String,
    pub entity_id: String,
    pub details: String,
}

#[derive(Clone)]
pub struct AppState {
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
    pub fn new() -> Self {
        Self {
            nodes: Arc::new(RwLock::new(HashMap::new())),
            jobs: Arc::new(RwLock::new(HashMap::new())),
            dispatches: Arc::new(RwLock::new(HashMap::new())),
            wasm_artifacts: Arc::new(RwLock::new(HashMap::new())),
            scheduler: Arc::new(EdgeScheduler::new(Default::default())),
            verification: Arc::new(VerificationEngine::new()),
            ledger: Arc::new(RwLock::new(MeteringLedger::new())),
            metrics: Arc::new(MetricsRegistry::new()),
            server_keypair: Arc::new(KeyPair::generate()),
            audit_log: Arc::new(RwLock::new(Vec::new())),
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
        let mut log = self.audit_log.write().await;
        log.push(record);
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
