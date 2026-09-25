use serde::{Deserialize, Serialize};
use spaas_protocol::job::JobResult;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalJobAuditEntry {
    pub job_id: Uuid,
    pub workload_name: String,
    pub started_at_ms: i64,
    pub completed_at_ms: i64,
    pub exit_code: i32,
    pub fuel_consumed: u64,
    pub wall_time_ms: u64,
    pub result_digest: String,
    pub success: bool,
}

#[derive(Debug, Default, Clone)]
pub struct LocalJobHistoryStore {
    entries: Arc<Mutex<Vec<LocalJobAuditEntry>>>,
}

impl LocalJobHistoryStore {
    pub fn new() -> Self {
        Self {
            entries: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn record_execution(
        &self,
        job_id: Uuid,
        workload_name: String,
        started_at_ms: i64,
        result: &JobResult,
    ) {
        let entry = LocalJobAuditEntry {
            job_id,
            workload_name,
            started_at_ms,
            completed_at_ms: result.completed_at_ms,
            exit_code: result.exit_code,
            fuel_consumed: result.fuel_consumed,
            wall_time_ms: result.wall_time_ms,
            result_digest: result.result_digest.clone(),
            success: result.exit_code == 0,
        };

        let mut lock = self.entries.lock().unwrap();
        lock.push(entry);
    }

    pub fn get_recent_entries(&self, limit: usize) -> Vec<LocalJobAuditEntry> {
        let lock = self.entries.lock().unwrap();
        lock.iter().rev().take(limit).cloned().collect()
    }

    pub fn total_jobs_recorded(&self) -> usize {
        self.entries.lock().unwrap().len()
    }
}
