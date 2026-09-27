use spaas_runtime::traits::{ExecutionContext, WorkloadRuntime};
use spaas_runtime::wasm_engine::WasmWasiRuntime;
use spaas_security::keys::KeyPair;

#[tokio::test]
async fn test_desktop_worker_wasm_execution_matrix_compute() {
    let runtime = WasmWasiRuntime::new();
    let keypair = KeyPair::generate();
    let node_id = uuid::Uuid::new_v4();
    let wasm_bytes = include_bytes!("../../../fixtures/matrix_compute.wasm");

    let spec = spaas_protocol::workload::WorkloadSpec {
        workload_id: uuid::Uuid::new_v4(),
        spec_version: "1.0.0".into(),
        name: "matrix_compute".into(),
        runtime: spaas_protocol::workload::RuntimeType::WasmWasi,
        artifact_sha256: spaas_security::hash::sha256_hex(wasm_bytes),
        artifact_size_bytes: wasm_bytes.len() as u64,
        artifact_uri: "catalog://matrix_compute".into(),
        entrypoint: "_start".into(),
        args: vec![],
        env_vars: vec![],
        limits: spaas_protocol::workload::ResourceLimits::default(),
        network_policy: spaas_protocol::workload::NetworkPolicy::None,
        required_capabilities: spaas_protocol::workload::RequiredCapabilities::default(),
        dimension_weights: spaas_protocol::workload::WorkloadDimensionWeights::default(),
        retry_policy: spaas_protocol::workload::RetryPolicy::default(),
        verification_policy: spaas_protocol::workload::VerificationPolicy::SingleNode,
        priority: spaas_protocol::workload::WorkloadPriority::Normal,
        submitter_signature: "".into(),
        submitter_pubkey: "".into(),
        created_at_ms: chrono::Utc::now().timestamp_millis(),
        preferred_regions: vec![],
        deadline_ms: None,
        category: "compute".into(),
        max_cost_credits: Some(10),
        data_locality_hint: None,
    };

    let ctx = ExecutionContext {
        spec: &spec,
        wasm_bytes,
        node_id,
        node_keypair: &keypair,
    };

    let result = runtime
        .execute(ctx)
        .await
        .expect("WASM execution must succeed");
    assert_eq!(result.exit_code, 0);
    assert!(result.fuel_consumed > 0);
    assert!(result.stdout.contains("Matrix Multiplication") || result.stdout.contains("FLOPs"));
}

#[tokio::test]
async fn test_desktop_worker_wasm_execution_sha256_hasher() {
    let runtime = WasmWasiRuntime::new();
    let keypair = KeyPair::generate();
    let node_id = uuid::Uuid::new_v4();
    let wasm_bytes = include_bytes!("../../../fixtures/sha256_hasher.wasm");

    let spec = spaas_protocol::workload::WorkloadSpec {
        workload_id: uuid::Uuid::new_v4(),
        spec_version: "1.0.0".into(),
        name: "sha256_hasher".into(),
        runtime: spaas_protocol::workload::RuntimeType::WasmWasi,
        artifact_sha256: spaas_security::hash::sha256_hex(wasm_bytes),
        artifact_size_bytes: wasm_bytes.len() as u64,
        artifact_uri: "catalog://sha256_hasher".into(),
        entrypoint: "_start".into(),
        args: vec![],
        env_vars: vec![],
        limits: spaas_protocol::workload::ResourceLimits::default(),
        network_policy: spaas_protocol::workload::NetworkPolicy::None,
        required_capabilities: spaas_protocol::workload::RequiredCapabilities::default(),
        dimension_weights: spaas_protocol::workload::WorkloadDimensionWeights::default(),
        retry_policy: spaas_protocol::workload::RetryPolicy::default(),
        verification_policy: spaas_protocol::workload::VerificationPolicy::SingleNode,
        priority: spaas_protocol::workload::WorkloadPriority::Normal,
        submitter_signature: "".into(),
        submitter_pubkey: "".into(),
        created_at_ms: chrono::Utc::now().timestamp_millis(),
        preferred_regions: vec![],
        deadline_ms: None,
        category: "compute".into(),
        max_cost_credits: Some(10),
        data_locality_hint: None,
    };

    let ctx = ExecutionContext {
        spec: &spec,
        wasm_bytes,
        node_id,
        node_keypair: &keypair,
    };

    let result = runtime
        .execute(ctx)
        .await
        .expect("SHA256 hasher must succeed");
    assert_eq!(result.exit_code, 0);
    assert!(result.fuel_consumed > 0);
    assert!(result.stdout.contains("SHA-256") || result.stdout.contains("SUCCESS"));
}

#[tokio::test]
async fn test_desktop_worker_wasm_execution_prime_sieve() {
    let runtime = WasmWasiRuntime::new();
    let keypair = KeyPair::generate();
    let node_id = uuid::Uuid::new_v4();
    let wasm_bytes = include_bytes!("../../../fixtures/prime_sieve.wasm");

    let spec = spaas_protocol::workload::WorkloadSpec {
        workload_id: uuid::Uuid::new_v4(),
        spec_version: "1.0.0".into(),
        name: "prime_sieve".into(),
        runtime: spaas_protocol::workload::RuntimeType::WasmWasi,
        artifact_sha256: spaas_security::hash::sha256_hex(wasm_bytes),
        artifact_size_bytes: wasm_bytes.len() as u64,
        artifact_uri: "catalog://prime_sieve".into(),
        entrypoint: "_start".into(),
        args: vec![],
        env_vars: vec![],
        limits: spaas_protocol::workload::ResourceLimits::default(),
        network_policy: spaas_protocol::workload::NetworkPolicy::None,
        required_capabilities: spaas_protocol::workload::RequiredCapabilities::default(),
        dimension_weights: spaas_protocol::workload::WorkloadDimensionWeights::default(),
        retry_policy: spaas_protocol::workload::RetryPolicy::default(),
        verification_policy: spaas_protocol::workload::VerificationPolicy::SingleNode,
        priority: spaas_protocol::workload::WorkloadPriority::Normal,
        submitter_signature: "".into(),
        submitter_pubkey: "".into(),
        created_at_ms: chrono::Utc::now().timestamp_millis(),
        preferred_regions: vec![],
        deadline_ms: None,
        category: "compute".into(),
        max_cost_credits: Some(10),
        data_locality_hint: None,
    };

    let ctx = ExecutionContext {
        spec: &spec,
        wasm_bytes,
        node_id,
        node_keypair: &keypair,
    };

    let result = runtime
        .execute(ctx)
        .await
        .expect("Prime sieve must succeed");
    assert_eq!(result.exit_code, 0);
    assert!(result.fuel_consumed > 0);
    assert!(result.stdout.contains("Prime Sieve") || result.stdout.contains("SUCCESS"));
}
