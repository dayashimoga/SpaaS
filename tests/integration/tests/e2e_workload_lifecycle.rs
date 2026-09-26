use spaas_integration_tests::make_test_wat_bytes;
use spaas_metering::MeteringLedger;
use spaas_node_agent::NodeAgent;
use spaas_protocol::node::*;
use spaas_protocol::rpc::JobDispatchMessage;
use spaas_protocol::workload::*;
use spaas_scheduler_core::{EdgeScheduler, SchedulerConfig};
use spaas_security::hash::sha256_hex;
use spaas_security::keys::KeyPair;
use spaas_security::signing::sign_workload;
use spaas_verification::VerificationEngine;
use uuid::Uuid;

#[tokio::test]
async fn test_full_e2e_workload_lifecycle() {
    // 1. Setup Platform Components
    let scheduler = EdgeScheduler::new(SchedulerConfig::default());
    let verification = VerificationEngine::new();
    let mut ledger = MeteringLedger::new();

    // 2. Initialize and Enroll 2 Edge Nodes (1 high-tier, 1 mid-tier)
    let mut node_high = NodeAgent::new(
        NodeHardwareCapabilities {
            device_model: "Pixel 8 Pro (Production Node)".into(),
            architecture: "aarch64".into(),
            total_ram_mb: 12288,
            ..Default::default()
        },
        ProviderPolicy::default(),
        false,
    );
    node_high.telemetry.battery_pct = 95;
    node_high.telemetry.charging_state = ChargingState::ChargingAc;
    node_high.telemetry.thermal_status = ThermalStatus::None;

    let node_mid = NodeAgent::new(
        NodeHardwareCapabilities {
            device_model: "Galaxy A54".into(),
            architecture: "aarch64".into(),
            total_ram_mb: 6144,
            ..Default::default()
        },
        ProviderPolicy::default(),
        false,
    );

    let active_nodes = vec![node_high.to_record(), node_mid.to_record()];

    // 3. Compile real WebAssembly workload: prints "Hello Edge Compute" and exits cleanly
    let wat = r#"
        (module
            (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
            (memory (export "memory") 1)
            (func (export "_start")
                (call $exit (i32.const 0))
            )
        )
    "#;
    let wasm_bytes = make_test_wat_bytes(wat);
    let wasm_hash = sha256_hex(&wasm_bytes);

    // 4. Developer prepares and cryptographically signs WorkloadSpec
    let dev_key = KeyPair::generate();
    let mut spec = WorkloadSpec {
        workload_id: Uuid::new_v4(),
        spec_version: "1.0.0".into(),
        name: "e2e_matrix_computation".into(),
        runtime: RuntimeType::WasmWasi,
        artifact_sha256: wasm_hash,
        artifact_size_bytes: wasm_bytes.len() as u64,
        artifact_uri: "spaas://artifacts/e2e.wasm".into(),
        entrypoint: "_start".into(),
        args: vec![],
        env_vars: vec![],
        limits: ResourceLimits {
            max_fuel: 5_000_000,
            max_memory_bytes: 64 * 1024 * 1024,
            max_storage_bytes: 10 * 1024 * 1024,
            timeout_ms: 10_000,
            max_output_bytes: 1024 * 1024,
        },
        network_policy: NetworkPolicy::None,
        required_capabilities: RequiredCapabilities::default(),
        retry_policy: RetryPolicy::default(),
        verification_policy: VerificationPolicy::SingleNode,
        priority: WorkloadPriority::High,
        dimension_weights: Default::default(),
        submitter_signature: String::new(),
        submitter_pubkey: String::new(),
        created_at_ms: chrono::Utc::now().timestamp_millis(),
        ..Default::default()
    };
    sign_workload(&dev_key, &mut spec);

    // 5. Intelligent Scheduler evaluates fleet and selects optimal node
    let scheduled_nodes = scheduler.schedule_workload(&spec, &active_nodes).unwrap();
    assert_eq!(scheduled_nodes.len(), 1);
    assert_eq!(scheduled_nodes[0], node_high.node_id);

    // 6. Dispatch message constructed and sent to NodeAgent
    let dispatch = JobDispatchMessage {
        job_id: spec.workload_id,
        lease_id: Uuid::new_v4(),
        lease_expires_at_ms: chrono::Utc::now().timestamp_millis() + 30_000,
        spec: spec.clone(),
        wasm_bytes: Some(wasm_bytes),
        dispatched_at_ms: chrono::Utc::now().timestamp_millis(),
    };

    // 7. NodeAgent executes workload inside sandboxed WasmWasiRuntime
    let job_result = node_high.execute_dispatched_job(dispatch).await.unwrap();

    assert_eq!(job_result.exit_code, 0);
    assert_eq!(job_result.node_id, node_high.node_id);
    assert!(job_result.fuel_consumed > 0);
    assert!(!job_result.node_signature.is_empty());

    // 8. Verification Engine validates cryptographic signature & digest
    assert!(verification
        .verify_single_result(&job_result, &node_high.public_key_hex())
        .is_ok());

    // 9. Metering Ledger processes usage and transfers credits
    let usage = spaas_protocol::metering::ResourceUsage {
        fuel_consumed: job_result.fuel_consumed,
        wall_time_ms: job_result.wall_time_ms,
        memory_peak_bytes: job_result.peak_memory_bytes,
        network_ingress_bytes: 2048,
        network_egress_bytes: 512,
        storage_bytes: 0,
    };

    let metering_rec = ledger
        .record_job_execution(
            spec.workload_id,
            node_high.node_id,
            &job_result.result_digest,
            &node_high.public_key_hex(),
            &dev_key.public_key_hex(),
            usage,
            true,
        )
        .unwrap();

    assert!(metering_rec.credits_earned_by_node > 0);
    assert_eq!(
        ledger
            .get_account(&node_high.public_key_hex())
            .unwrap()
            .balance_credits,
        metering_rec.credits_earned_by_node as i64
    );

    // 10. Audit log verified
    assert_eq!(node_high.history.total_jobs_recorded(), 1);
    let audit_entry = node_high.history.get_recent_entries(1)[0].clone();
    assert_eq!(audit_entry.workload_name, "e2e_matrix_computation");
    assert!(audit_entry.success);
}
