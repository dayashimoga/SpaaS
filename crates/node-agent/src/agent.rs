use crate::history::LocalJobHistoryStore;
use crate::monitor::{ResourceSafetyMonitor, YieldReason};
use spaas_protocol::job::JobResult;
use spaas_protocol::node::{
    EnrollmentStatus, NodeHardwareCapabilities, NodeRecord, NodeState, NodeTelemetry, ProviderPolicy,
};
use spaas_protocol::rpc::JobDispatchMessage;
use spaas_runtime::traits::{ExecutionContext, WorkloadRuntime};
use spaas_runtime::wasm_engine::WasmWasiRuntime;
use spaas_runtime::RuntimeError;
use spaas_security::keys::KeyPair;
use spaas_security::signing::verify_workload;
use tracing::{info, warn};
use uuid::Uuid;

pub struct NodeAgent {
    pub node_id: Uuid,
    pub keypair: KeyPair,
    pub capabilities: NodeHardwareCapabilities,
    pub telemetry: NodeTelemetry,
    pub policy: ProviderPolicy,
    pub enrollment: EnrollmentStatus,
    pub state: NodeState,
    pub history: LocalJobHistoryStore,
    pub runtime: WasmWasiRuntime,
    pub is_simulated: bool,
}

impl NodeAgent {
    pub fn new(
        capabilities: NodeHardwareCapabilities,
        policy: ProviderPolicy,
        is_simulated: bool,
    ) -> Self {
        let keypair = KeyPair::generate();
        let node_id = Uuid::new_v4();

        Self {
            node_id,
            keypair,
            capabilities,
            telemetry: NodeTelemetry::default(),
            policy,
            enrollment: EnrollmentStatus::Enrolled,
            state: NodeState::Idle,
            history: LocalJobHistoryStore::new(),
            runtime: WasmWasiRuntime::new(),
            is_simulated,
        }
    }

    pub fn public_key_hex(&self) -> String {
        self.keypair.public_key_hex()
    }

    /// Creates current NodeRecord snapshot for control plane registration and heartbeats
    pub fn to_record(&self) -> NodeRecord {
        NodeRecord {
            node_id: self.node_id,
            public_key: self.public_key_hex(),
            device_type: if self.is_simulated {
                spaas_protocol::node::NodeDeviceType::SimulatedNode
            } else {
                spaas_protocol::node::NodeDeviceType::AndroidSmartphone
            },
            enrollment: self.enrollment,
            state: self.state,
            capabilities: self.capabilities.clone(),
            telemetry: self.telemetry.clone(),
            policy: self.policy.clone(),
            enrolled_at_ms: chrono::Utc::now().timestamp_millis(),
            last_heartbeat_ms: chrono::Utc::now().timestamp_millis(),
            region: "local".into(),
            is_simulated: self.is_simulated,
        }
    }

    /// User explicit pause
    pub fn pause(&mut self) {
        self.policy.is_user_paused = true;
        self.state = NodeState::Paused;
        info!(node_id = %self.node_id, "Node agent explicitly PAUSED by user");
    }

    /// User explicit resume
    pub fn resume(&mut self) {
        self.policy.is_user_paused = false;
        self.state = NodeState::Idle;
        info!(node_id = %self.node_id, "Node agent RESUMED by user");
    }

    /// Updates dynamic telemetry and checks for automatic safety yield
    pub fn update_telemetry(&mut self, new_telemetry: NodeTelemetry) -> Option<YieldReason> {
        self.telemetry = new_telemetry;
        let yield_check = ResourceSafetyMonitor::check_safety_yield(&self.telemetry, &self.policy);
        if yield_check.is_some() && self.state != NodeState::Paused {
            self.state = NodeState::Paused;
        } else if yield_check.is_none() && self.state == NodeState::Paused && !self.policy.is_user_paused {
            self.state = NodeState::Idle;
        }
        yield_check
    }

    /// Dispatches and executes a workload received from the control plane
    pub async fn execute_dispatched_job(
        &mut self,
        dispatch: JobDispatchMessage,
    ) -> Result<JobResult, RuntimeError> {
        // 1. Verify safety conditions before running
        if let Some(yield_reason) =
            ResourceSafetyMonitor::check_safety_yield(&self.telemetry, &self.policy)
        {
            return Err(RuntimeError::Internal(format!(
                "Node safety threshold triggered ({yield_reason:?}); job execution yielded"
            )));
        }

        // 2. Verify submitter cryptographic signature on WorkloadSpec
        verify_workload(&dispatch.spec).map_err(|e| {
            RuntimeError::ArtifactVerificationFailed(format!("Workload signature invalid: {e}"))
        })?;

        // 3. Extract WASM bytes (from dispatch message or artifact)
        let wasm_bytes = match &dispatch.wasm_bytes {
            Some(bytes) => bytes.as_slice(),
            None => {
                return Err(RuntimeError::CompilationFailed(
                    "No wasm bytecode payload attached".into(),
                ));
            }
        };

        // 4. Mark state active
        self.state = NodeState::Active;
        self.telemetry.active_job_count += 1;
        let start_time_ms = chrono::Utc::now().timestamp_millis();

        let ctx = ExecutionContext {
            spec: &dispatch.spec,
            wasm_bytes,
            node_id: self.node_id,
            node_keypair: &self.keypair,
        };

        let result = self.runtime.execute(ctx).await;

        // 5. Update state and record history
        self.telemetry.active_job_count = self.telemetry.active_job_count.saturating_sub(1);
        self.state = NodeState::Idle;

        match &result {
            Ok(res) => {
                self.telemetry.total_jobs_completed += 1;
                self.history.record_execution(
                    dispatch.job_id,
                    dispatch.spec.name.clone(),
                    start_time_ms,
                    res,
                );
                info!(
                    job_id = %dispatch.job_id,
                    fuel = res.fuel_consumed,
                    wall_ms = res.wall_time_ms,
                    "Job executed and sealed successfully by node agent"
                );
            }
            Err(e) => {
                self.telemetry.total_jobs_failed += 1;
                warn!(
                    job_id = %dispatch.job_id,
                    error = %e,
                    "Job execution failed on node"
                );
            }
        }

        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use spaas_protocol::workload::*;
    use spaas_security::hash::sha256_hex;
    use spaas_security::signing::sign_workload;

    fn make_test_wasm() -> Vec<u8> {
        let wat = r#"
            (module
                (memory (export "memory") 1)
                (func (export "_start"))
            )
        "#;
        wat::parse_str(wat).unwrap()
    }

    #[tokio::test]
    async fn test_node_agent_execution_flow() {
        let mut agent = NodeAgent::new(
            NodeHardwareCapabilities::default(),
            ProviderPolicy::default(),
            true,
        );

        let wasm = make_test_wasm();
        let submitter_key = KeyPair::generate();
        let mut spec = WorkloadSpec {
            workload_id: Uuid::new_v4(),
            spec_version: "1.0.0".into(),
            name: "test_job".into(),
            runtime: RuntimeType::WasmWasi,
            artifact_sha256: sha256_hex(&wasm),
            artifact_size_bytes: wasm.len() as u64,
            artifact_uri: "memory://test.wasm".into(),
            entrypoint: "_start".into(),
            args: vec![],
            env_vars: vec![],
            limits: ResourceLimits::default(),
            network_policy: NetworkPolicy::None,
            required_capabilities: RequiredCapabilities::default(),
            retry_policy: RetryPolicy::default(),
            verification_policy: VerificationPolicy::SingleNode,
            priority: WorkloadPriority::Normal,
            submitter_signature: String::new(),
            submitter_pubkey: String::new(),
            created_at_ms: 1000,
        };
        sign_workload(&submitter_key, &mut spec);

        let dispatch = JobDispatchMessage {
            job_id: spec.workload_id,
            spec,
            wasm_bytes: Some(wasm),
            dispatched_at_ms: chrono::Utc::now().timestamp_millis(),
        };

        let result = agent.execute_dispatched_job(dispatch).await.unwrap();
        assert_eq!(result.exit_code, 0);
        assert_eq!(agent.history.total_jobs_recorded(), 1);
        assert_eq!(agent.telemetry.total_jobs_completed, 1);
    }
}
