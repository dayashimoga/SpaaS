use crate::job::{JobRecord, JobResult};
use crate::node::{NodeHardwareCapabilities, NodeRecord, NodeTelemetry, ProviderPolicy};
use crate::workload::WorkloadSpec;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterNodeRequest {
    pub public_key: String, // Ed25519 hex
    pub device_type: crate::node::NodeDeviceType,
    pub capabilities: NodeHardwareCapabilities,
    pub initial_telemetry: NodeTelemetry,
    pub initial_policy: ProviderPolicy,
    pub region: String,
    pub is_simulated: bool,
    /// Signature of (public_key + timestamp) verifying possession of private key
    pub enrollment_signature: String,
    pub timestamp_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterNodeResponse {
    pub node_id: Uuid,
    pub auth_token: String,
    pub control_plane_pubkey: String,
    pub heartbeat_interval_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatRequest {
    pub node_id: Uuid,
    pub telemetry: NodeTelemetry,
    pub policy: ProviderPolicy,
    pub timestamp_ms: i64,
    /// Heartbeat signature
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatResponse {
    pub acknowledged: bool,
    pub pending_jobs_count: usize,
    pub command: Option<NodeRemoteCommand>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum NodeRemoteCommand {
    PauseExecution,
    ResumeExecution,
    CancelJob { job_id: Uuid },
    ReEnumerateCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmitJobRequest {
    pub spec: WorkloadSpec,
    /// Raw WASM binary base64-encoded if small, or pre-uploaded URI
    pub wasm_binary_base64: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmitJobResponse {
    pub job_id: Uuid,
    pub state: crate::job::JobState,
    pub queued_at_ms: i64,
    pub estimated_wait_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PollJobRequest {
    pub node_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PollJobResponse {
    pub job: Option<JobDispatchMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobDispatchMessage {
    pub job_id: Uuid,
    pub lease_id: Uuid,
    pub lease_expires_at_ms: i64,
    pub spec: WorkloadSpec,
    /// Directly embedded wasm binary if inline, or URL
    pub wasm_bytes: Option<Vec<u8>>,
    pub dispatched_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenewLeaseRequest {
    pub job_id: Uuid,
    pub node_id: Uuid,
    pub lease_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenewLeaseResponse {
    pub renewed: bool,
    pub lease_id: Uuid,
    pub expires_at_ms: i64,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmitJobResultRequest {
    pub node_id: Uuid,
    pub lease_id: Option<Uuid>,
    pub result: JobResult,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmitJobResultResponse {
    pub accepted: bool,
    pub verification_status: String,
    pub credits_earned: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemHealthResponse {
    pub status: String,
    pub active_nodes: usize,
    pub idle_nodes: usize,
    pub paused_nodes: usize,
    pub offline_nodes: usize,
    pub queue_depth: usize,
    pub running_jobs: usize,
    pub completed_jobs: u64,
    pub failed_jobs: u64,
    pub average_scheduling_latency_ms: f64,
    pub uptime_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListNodesResponse {
    pub nodes: Vec<NodeRecord>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListJobsResponse {
    pub jobs: Vec<JobRecord>,
    pub total: usize,
}
