use spaas_integration_tests::make_test_wat_bytes;
use spaas_node_agent::NodeAgent;
use spaas_protocol::job::{JobRecord, JobState};
use spaas_protocol::node::*;
use spaas_protocol::rpc::JobDispatchMessage;
use spaas_protocol::workload::*;
use spaas_scheduler_core::{EdgeScheduler, SchedulerConfig};
use spaas_security::hash::sha256_hex;
use spaas_security::keys::KeyPair;
use spaas_security::signing::sign_workload;
use uuid::Uuid;

#[tokio::test]
async fn test_node_disappearance_and_autonomous_reschedule() {
    let scheduler = EdgeScheduler::new(SchedulerConfig::default());

    // 1. Create two nodes: Node A (active) and Node B (standby)
    let node_a = NodeAgent::new(
        NodeHardwareCapabilities {
            device_model: "Phone A (Primary)".into(),
            ..Default::default()
        },
        ProviderPolicy::default(),
        false,
    );

    let mut node_b = NodeAgent::new(
        NodeHardwareCapabilities {
            device_model: "Phone B (Standby Backup)".into(),
            ..Default::default()
        },
        ProviderPolicy::default(),
        false,
    );

    let wasm = make_test_wat_bytes(r#"(module (memory (export "memory") 1) (func (export "_start")))"#);
    let dev_key = KeyPair::generate();

    let mut spec = WorkloadSpec {
        workload_id: Uuid::new_v4(),
        spec_version: "1.0.0".into(),
        name: "resilience_test_workload".into(),
        runtime: RuntimeType::WasmWasi,
        artifact_sha256: sha256_hex(&wasm),
        artifact_size_bytes: wasm.len() as u64,
        artifact_uri: "inline".into(),
        entrypoint: "_start".into(),
        args: vec![],
        env_vars: vec![],
        limits: ResourceLimits::default(),
        network_policy: NetworkPolicy::None,
        required_capabilities: RequiredCapabilities::default(),
        retry_policy: RetryPolicy {
            max_retries: 3,
            initial_backoff_ms: 50,
        },
        verification_policy: VerificationPolicy::SingleNode,
        priority: WorkloadPriority::Normal,
        submitter_signature: String::new(),
        submitter_pubkey: String::new(),
        created_at_ms: chrono::Utc::now().timestamp_millis(),
    };
    sign_workload(&dev_key, &mut spec);

    // Initial Job state
    let mut job = JobRecord::new(spec.clone());
    assert_eq!(job.state, JobState::Queued);

    // 2. Schedule initially to Node A
    let initial_nodes = vec![node_a.to_record()];
    let selected = scheduler.schedule_workload(&spec, &initial_nodes).unwrap();
    job.assigned_node_id = Some(selected[0]);
    job.transition_to(JobState::Scheduled).unwrap();
    assert_eq!(job.assigned_node_id, Some(node_a.node_id));

    // 3. FAILURE INJECTION: Node A abruptly crashes / disappears mid-execution!
    // Control Plane reconciler marks Node A offline and triggers job retry
    assert!(job.transition_to(JobState::Retrying).is_ok());
    assert_eq!(job.retry_count, 1);
    assert_eq!(job.assigned_node_id, None); // Cleared for fresh assignment

    // Re-queue
    assert!(job.transition_to(JobState::Queued).is_ok());

    // 4. Autonomous Rescheduling: Node B is now available
    let available_nodes_after_failure = vec![node_b.to_record()];
    let re_selected = scheduler.schedule_workload(&spec, &available_nodes_after_failure).unwrap();
    assert_eq!(re_selected[0], node_b.node_id);

    job.assigned_node_id = Some(node_b.node_id);
    job.transition_to(JobState::Scheduled).unwrap();

    // 5. Node B executes the recovered job to completion
    let dispatch = JobDispatchMessage {
        job_id: job.job_id,
        spec,
        wasm_bytes: Some(wasm),
        dispatched_at_ms: chrono::Utc::now().timestamp_millis(),
    };

    let result = node_b.execute_dispatched_job(dispatch).await.unwrap();
    assert_eq!(result.exit_code, 0);

    job.result = Some(result);
    job.transition_to(JobState::Running).unwrap();
    job.transition_to(JobState::Verifying).unwrap();
    job.transition_to(JobState::Completed).unwrap();

    assert_eq!(job.state, JobState::Completed);
    assert_eq!(job.retry_count, 1);
    assert_eq!(job.assigned_node_id, Some(node_b.node_id));
}
