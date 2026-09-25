use crate::error::ProtocolError;
use crate::workload::WorkloadSpec;
use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum JobState {
    /// Workload submitted, waiting in scheduling priority queue
    Queued,
    /// Dispatched and bound to an eligible node
    Scheduled,
    /// Node reported execution in progress inside WASM sandbox
    Running,
    /// Node returned output, currently undergoing cryptographic or consensus verification
    Verifying,
    /// Result verified, accepted, and metered (Terminal state)
    Completed,
    /// Node dropped or errored; job queued for retry on a different node
    Retrying,
    /// Execution deadline exceeded (Terminal or Retrying)
    TimedOut,
    /// Unrecoverable failure or max retries exceeded (Terminal state)
    Failed,
    /// Cancelled explicitly by submitter or operator (Terminal state)
    Cancelled,
}

impl JobState {
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }

    /// Validates if transition from `self` to `next` is mathematically and protocol legal
    pub fn can_transition_to(&self, next: JobState) -> bool {
        if *self == next {
            // Idempotent self-transitions allowed
            return true;
        }
        if self.is_terminal() {
            // Terminal states cannot transition to anything else
            return false;
        }

        match (self, next) {
            (JobState::Queued, JobState::Scheduled) => true,
            (JobState::Queued, JobState::Cancelled) => true,

            (JobState::Scheduled, JobState::Running) => true,
            (JobState::Scheduled, JobState::Retrying) => true,
            (JobState::Scheduled, JobState::TimedOut) => true,
            (JobState::Scheduled, JobState::Failed) => true,
            (JobState::Scheduled, JobState::Cancelled) => true,

            (JobState::Running, JobState::Verifying) => true,
            (JobState::Running, JobState::Retrying) => true,
            (JobState::Running, JobState::TimedOut) => true,
            (JobState::Running, JobState::Failed) => true,
            (JobState::Running, JobState::Cancelled) => true,

            (JobState::Verifying, JobState::Completed) => true,
            (JobState::Verifying, JobState::Retrying) => true,
            (JobState::Verifying, JobState::Failed) => true,
            (JobState::Verifying, JobState::Cancelled) => true,

            (JobState::Retrying, JobState::Queued) => true,
            (JobState::Retrying, JobState::Failed) => true,
            (JobState::Retrying, JobState::Cancelled) => true,

            (JobState::TimedOut, JobState::Retrying) => true,
            (JobState::TimedOut, JobState::Failed) => true,
            (JobState::TimedOut, JobState::Cancelled) => true,

            _ => false,
        }
    }
}

impl fmt::Display for JobState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}", self)
    }
}

/// Cryptographically sealed execution output returned by worker node
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobResult {
    pub result_id: Uuid,
    pub job_id: Uuid,
    pub node_id: Uuid,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    /// SHA-256 of stdout concatenated with exit_code and return buffers
    pub result_digest: String,
    /// Exact WebAssembly fuel units consumed
    pub fuel_consumed: u64,
    /// Wall-clock execution duration in milliseconds
    pub wall_time_ms: u64,
    /// Peak linear memory allocated in bytes
    pub peak_memory_bytes: u64,
    /// Ed25519 signature of the `result_digest` using the worker node's private key
    pub node_signature: String,
    pub completed_at_ms: i64,
}

impl JobResult {
    /// Computes canonical result digest string for node signing and verification
    pub fn compute_digest(exit_code: i32, stdout: &str, stderr: &str, fuel: u64) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(exit_code.to_le_bytes());
        hasher.update(stdout.as_bytes());
        hasher.update(stderr.as_bytes());
        hasher.update(fuel.to_le_bytes());
        hex::encode(hasher.finalize())
    }
}

/// Full tracking record of a distributed job in the control plane
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobRecord {
    pub job_id: Uuid,
    pub spec: WorkloadSpec,
    pub state: JobState,
    pub assigned_node_id: Option<Uuid>,
    pub retry_count: u32,
    pub created_at_ms: i64,
    pub scheduled_at_ms: Option<i64>,
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
    pub result: Option<JobResult>,
    pub error_message: Option<String>,
    pub credit_cost: Option<u64>,
}

impl JobRecord {
    pub fn new(spec: WorkloadSpec) -> Self {
        let now = chrono::Utc::now().timestamp_millis();
        Self {
            job_id: Uuid::new_v4(),
            spec,
            state: JobState::Queued,
            assigned_node_id: None,
            retry_count: 0,
            created_at_ms: now,
            scheduled_at_ms: None,
            started_at_ms: None,
            completed_at_ms: None,
            result: None,
            error_message: None,
            credit_cost: None,
        }
    }

    /// Applies state transition with strict validation
    pub fn transition_to(&mut self, next: JobState) -> Result<(), ProtocolError> {
        if !self.state.can_transition_to(next) {
            return Err(ProtocolError::InvalidStateTransition {
                from: self.state.to_string(),
                to: next.to_string(),
            });
        }
        let now = chrono::Utc::now().timestamp_millis();
        match next {
            JobState::Scheduled => self.scheduled_at_ms = Some(now),
            JobState::Running => self.started_at_ms = Some(now),
            JobState::Completed | JobState::Failed | JobState::Cancelled => {
                self.completed_at_ms = Some(now);
            }
            JobState::Retrying => {
                self.retry_count += 1;
                self.assigned_node_id = None;
            }
            _ => {}
        }
        self.state = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workload::ResourceLimits;

    #[test]
    fn test_valid_state_transitions() {
        let mut job = JobRecord::new(WorkloadSpec {
            workload_id: Uuid::new_v4(),
            spec_version: "1.0.0".into(),
            name: "test".into(),
            runtime: crate::workload::RuntimeType::WasmWasi,
            artifact_sha256: "hash".into(),
            artifact_size_bytes: 100,
            artifact_uri: "uri".into(),
            entrypoint: "_start".into(),
            args: vec![],
            env_vars: vec![],
            limits: ResourceLimits::default(),
            network_policy: crate::workload::NetworkPolicy::None,
            required_capabilities: crate::workload::RequiredCapabilities::default(),
            retry_policy: crate::workload::RetryPolicy::default(),
            verification_policy: crate::workload::VerificationPolicy::SingleNode,
            priority: crate::workload::WorkloadPriority::Normal,
            submitter_signature: "sig".into(),
            submitter_pubkey: "pub".into(),
            created_at_ms: 1000,
        });

        assert_eq!(job.state, JobState::Queued);
        assert!(job.transition_to(JobState::Scheduled).is_ok());
        assert!(job.transition_to(JobState::Running).is_ok());
        assert!(job.transition_to(JobState::Verifying).is_ok());
        assert!(job.transition_to(JobState::Completed).is_ok());

        // Terminal state should disallow any further transition
        assert!(job.transition_to(JobState::Running).is_err());
    }

    #[test]
    fn test_retry_transition() {
        let mut job = JobRecord::new(WorkloadSpec {
            workload_id: Uuid::new_v4(),
            spec_version: "1.0.0".into(),
            name: "test".into(),
            runtime: crate::workload::RuntimeType::WasmWasi,
            artifact_sha256: "hash".into(),
            artifact_size_bytes: 100,
            artifact_uri: "uri".into(),
            entrypoint: "_start".into(),
            args: vec![],
            env_vars: vec![],
            limits: ResourceLimits::default(),
            network_policy: crate::workload::NetworkPolicy::None,
            required_capabilities: crate::workload::RequiredCapabilities::default(),
            retry_policy: crate::workload::RetryPolicy::default(),
            verification_policy: crate::workload::VerificationPolicy::SingleNode,
            priority: crate::workload::WorkloadPriority::Normal,
            submitter_signature: "sig".into(),
            submitter_pubkey: "pub".into(),
            created_at_ms: 1000,
        });

        job.transition_to(JobState::Scheduled).unwrap();
        job.transition_to(JobState::Retrying).unwrap();
        assert_eq!(job.retry_count, 1);
        job.transition_to(JobState::Queued).unwrap();
        assert_eq!(job.state, JobState::Queued);
    }
}
