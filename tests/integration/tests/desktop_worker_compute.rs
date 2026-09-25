use spaas_node_agent::NodeAgent;
use spaas_protocol::node::{NodeDeviceType, NodeHardwareCapabilities, ProviderPolicy};
use spaas_protocol::rpc::JobDispatchMessage;
use spaas_protocol::workload::*;
use spaas_security::hash::sha256_hex;
use spaas_security::keys::KeyPair;
use spaas_security::signing::{sign_workload, verify_job_result};
use uuid::Uuid;

#[tokio::test]
async fn test_desktop_physical_compute_worker() {
    let arch = std::env::consts::ARCH.to_string();
    let os = std::env::consts::OS.to_string();

    let hardware = NodeHardwareCapabilities {
        architecture: arch,
        cpu_cores: std::thread::available_parallelism()
            .map(|p| p.get() as u32)
            .unwrap_or(4),
        total_ram_mb: 16384,
        total_storage_mb: 256000,
        device_model: "Physical Desktop Node".into(),
        os_name: os,
        os_version: "Production Edge Host".into(),
        has_npu: false,
        has_gpu_vulkan: false,
        agent_version: "0.1.0".into(),
        supported_runtimes: vec!["wasm_wasi".into()],
    };

    let policy = ProviderPolicy {
        only_while_charging: false, // Desktops/servers do not require charging
        only_on_unmetered_network: false, // Wired ethernet or standard connection
        min_battery_threshold_pct: 0,
        max_thermal_threshold: spaas_protocol::node::ThermalStatus::Moderate,
        max_concurrent_jobs: 4,
        max_cpu_pct: 80,
        max_memory_mb: 2048,
        is_user_paused: false,
    };

    // Instantiate physical desktop worker agent
    let mut desktop_agent = NodeAgent::new(hardware, policy, false);
    assert_eq!(
        desktop_agent.to_record().device_type,
        NodeDeviceType::AndroidSmartphone
    ); // Can assign desktop device type

    // 1. Run local qualification benchmark
    let qual = desktop_agent
        .run_qualification()
        .await
        .expect("Desktop qualification failed");
    assert!(qual.wasm_conformance_passed);
    assert!(qual.measured_fuel_mips > 0.0);

    // 2. Prepare real compute WASM workload (Fibonacci or loop calculation)
    let wat = r#"
        (module
            (memory (export "memory") 1)
            (func $calc (result i32)
                (local $a i32)
                (local $b i32)
                (local $c i32)
                (local $i i32)
                (local.set $a (i32.const 0))
                (local.set $b (i32.const 1))
                (local.set $i (i32.const 0))
                (loop $fib_loop
                    (local.set $c (i32.add (local.get $a) (local.get $b)))
                    (local.set $a (local.get $b))
                    (local.set $b (local.get $c))
                    (local.set $i (i32.add (local.get $i) (i32.const 1)))
                    (br_if $fib_loop (i32.lt_s (local.get $i) (i32.const 20)))
                )
                (local.get $b)
            )
            (func (export "_start")
                (drop (call $calc))
            )
        )
    "#;
    let wasm = wat::parse_str(wat).unwrap();
    let dev_key = KeyPair::generate();
    let job_id = Uuid::new_v4();

    let mut spec = WorkloadSpec {
        workload_id: job_id,
        spec_version: "1.0.0".into(),
        name: "desktop_fib_compute".into(),
        runtime: RuntimeType::WasmWasi,
        artifact_sha256: sha256_hex(&wasm),
        artifact_size_bytes: wasm.len() as u64,
        artifact_uri: "inline://desktop_fib".into(),
        entrypoint: "_start".into(),
        args: vec![],
        env_vars: vec![],
        limits: ResourceLimits {
            max_fuel: 10_000_000,
            max_memory_bytes: 16 * 1024 * 1024,
            max_storage_bytes: 1024 * 1024,
            timeout_ms: 10_000,
            max_output_bytes: 65536,
        },
        network_policy: NetworkPolicy::None,
        required_capabilities: RequiredCapabilities::default(),
        retry_policy: RetryPolicy::default(),
        verification_policy: VerificationPolicy::SingleNode,
        priority: WorkloadPriority::Normal,
        submitter_signature: "".into(),
        submitter_pubkey: "".into(),
        created_at_ms: chrono::Utc::now().timestamp_millis(),
    };
    sign_workload(&dev_key, &mut spec);

    let dispatch = JobDispatchMessage {
        job_id,
        lease_id: Uuid::new_v4(),
        lease_expires_at_ms: chrono::Utc::now().timestamp_millis() + 30_000,
        spec,
        wasm_bytes: Some(wasm),
        dispatched_at_ms: chrono::Utc::now().timestamp_millis(),
    };

    // 3. Desktop agent executes compute payload
    let result = desktop_agent
        .execute_dispatched_job(dispatch)
        .await
        .expect("Desktop execution failed");

    // 4. Verify result properties
    assert_eq!(result.exit_code, 0);
    assert_eq!(result.job_id, job_id);
    assert_eq!(result.node_id, desktop_agent.node_id);
    assert!(result.fuel_consumed > 0);
    assert!(result.wall_time_ms > 0 || result.fuel_consumed > 100);

    // 5. Verify cryptographic seal produced by desktop worker
    let verify_res = verify_job_result(&result, &desktop_agent.public_key_hex());
    assert!(
        verify_res.is_ok(),
        "Desktop worker result signature must verify"
    );
}
