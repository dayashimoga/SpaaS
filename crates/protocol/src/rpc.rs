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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::{NodeDeviceType, NodeHardwareCapabilities, NodeTelemetry, ProviderPolicy};

    #[test]
    fn test_rpc_messages_serde() {
        let node_id = Uuid::new_v4();
        let job_id = Uuid::new_v4();
        let lease_id = Uuid::new_v4();

        // 1. RegisterNodeRequest
        let reg_req = RegisterNodeRequest {
            public_key: "abc123pubkey".into(),
            device_type: NodeDeviceType::AndroidSmartphone,
            capabilities: NodeHardwareCapabilities::default(),
            initial_telemetry: NodeTelemetry::default(),
            initial_policy: ProviderPolicy::default(),
            region: "us-west".into(),
            is_simulated: true,
            enrollment_signature: "sig123".into(),
            timestamp_ms: 1000,
        };
        let reg_json = serde_json::to_string(&reg_req).unwrap();
        let reg_deser: RegisterNodeRequest = serde_json::from_str(&reg_json).unwrap();
        assert_eq!(reg_deser.region, "us-west");
        assert_eq!(reg_deser.public_key, "abc123pubkey");

        // 2. RegisterNodeResponse
        let reg_resp = RegisterNodeResponse {
            node_id,
            auth_token: "tok_xyz".into(),
            control_plane_pubkey: "cp_pub".into(),
            heartbeat_interval_secs: 15,
        };
        let resp_json = serde_json::to_string(&reg_resp).unwrap();
        let resp_deser: RegisterNodeResponse = serde_json::from_str(&resp_json).unwrap();
        assert_eq!(resp_deser.node_id, node_id);
        assert_eq!(resp_deser.heartbeat_interval_secs, 15);

        // 3. HeartbeatRequest & Response with NodeRemoteCommand
        let hb_req = HeartbeatRequest {
            node_id,
            telemetry: NodeTelemetry::default(),
            policy: ProviderPolicy::default(),
            timestamp_ms: 2000,
            signature: "sig_hb".into(),
        };
        let hb_json = serde_json::to_string(&hb_req).unwrap();
        assert!(hb_json.contains("sig_hb"));

        let hb_resp = HeartbeatResponse {
            acknowledged: true,
            pending_jobs_count: 2,
            command: Some(NodeRemoteCommand::CancelJob { job_id }),
        };
        let hb_resp_json = serde_json::to_string(&hb_resp).unwrap();
        let hb_resp_deser: HeartbeatResponse = serde_json::from_str(&hb_resp_json).unwrap();
        assert!(hb_resp_deser.acknowledged);
        assert_eq!(hb_resp_deser.pending_jobs_count, 2);

        // Test other NodeRemoteCommands
        let pause_cmd = NodeRemoteCommand::PauseExecution;
        let resume_cmd = NodeRemoteCommand::ResumeExecution;
        let renum_cmd = NodeRemoteCommand::ReEnumerateCapabilities;
        assert!(serde_json::to_string(&pause_cmd)
            .unwrap()
            .contains("pause_execution"));
        assert!(serde_json::to_string(&resume_cmd)
            .unwrap()
            .contains("resume_execution"));
        assert!(serde_json::to_string(&renum_cmd)
            .unwrap()
            .contains("re_enumerate_capabilities"));

        // 4. JobDispatchMessage & PollJob
        let dispatch = JobDispatchMessage {
            job_id,
            lease_id,
            lease_expires_at_ms: 50000,
            spec: WorkloadSpec::default(),
            wasm_bytes: Some(vec![0x00, 0x61, 0x73, 0x6d]),
            dispatched_at_ms: 25000,
        };
        let poll_resp = PollJobResponse {
            job: Some(dispatch),
        };
        let poll_json = serde_json::to_string(&poll_resp).unwrap();
        let poll_deser: PollJobResponse = serde_json::from_str(&poll_json).unwrap();
        assert!(poll_deser.job.is_some());
        assert_eq!(poll_deser.job.unwrap().job_id, job_id);

        // 5. RenewLease
        let renew_req = RenewLeaseRequest {
            job_id,
            node_id,
            lease_id,
        };
        let renew_resp = RenewLeaseResponse {
            renewed: true,
            lease_id,
            expires_at_ms: 60000,
            reason: None,
        };
        let renew_json = serde_json::to_string(&renew_req).unwrap();
        let renew_resp_json = serde_json::to_string(&renew_resp).unwrap();
        assert!(renew_json.contains(&job_id.to_string()));
        assert!(renew_resp_json.contains("renewed"));

        // 6. SubmitJobResult
        let submit_res_req = SubmitJobResultRequest {
            node_id,
            lease_id: Some(lease_id),
            result: JobResult {
                result_id: Uuid::new_v4(),
                job_id,
                node_id,
                exit_code: 0,
                stdout: "ok".into(),
                stderr: "".into(),
                result_digest: "sha_xyz".into(),
                fuel_consumed: 100,
                wall_time_ms: 10,
                peak_memory_bytes: 1024,
                node_signature: "sig_node".into(),
                completed_at_ms: 2000,
            },
        };
        let submit_res_resp = SubmitJobResultResponse {
            accepted: true,
            verification_status: "VERIFIED".into(),
            credits_earned: 50,
        };
        assert!(serde_json::to_string(&submit_res_req)
            .unwrap()
            .contains("sha_xyz"));
        assert!(serde_json::to_string(&submit_res_resp)
            .unwrap()
            .contains("VERIFIED"));

        // 7. SystemHealthResponse, ListNodesResponse, ListJobsResponse
        let health = SystemHealthResponse {
            status: "HEALTHY".into(),
            active_nodes: 5,
            idle_nodes: 3,
            paused_nodes: 1,
            offline_nodes: 0,
            queue_depth: 2,
            running_jobs: 1,
            completed_jobs: 100,
            failed_jobs: 2,
            average_scheduling_latency_ms: 4.5,
            uptime_secs: 3600,
        };
        assert!(serde_json::to_string(&health).unwrap().contains("HEALTHY"));

        let list_nodes = ListNodesResponse {
            nodes: vec![],
            total: 0,
        };
        let list_jobs = ListJobsResponse {
            jobs: vec![],
            total: 0,
        };
        assert_eq!(
            serde_json::from_str::<ListNodesResponse>(&serde_json::to_string(&list_nodes).unwrap())
                .unwrap()
                .total,
            0
        );
        assert_eq!(
            serde_json::from_str::<ListJobsResponse>(&serde_json::to_string(&list_jobs).unwrap())
                .unwrap()
                .total,
            0
        );
    }
}
