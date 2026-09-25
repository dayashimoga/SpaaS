use spaas_protocol::workload::*;
use spaas_runtime::traits::{ExecutionContext, WorkloadRuntime};
use spaas_runtime::wasm_engine::WasmWasiRuntime;
use spaas_security::hash::sha256_hex;
use spaas_security::keys::KeyPair;
use uuid::Uuid;

#[tokio::test]
async fn test_developer_manifest_parse_and_execution() {
    let yaml_manifest = r#"
apiVersion: spaas.io/v1
kind: Workload
metadata:
  name: edge-prime-sieve
  version: 1.2.0
  description: High efficiency prime sieve on voluntary edge smartphones
spec:
  runtime: wasm_wasi
  wasi_version: preview1
  entrypoint: _start
  binary: ./prime_sieve.wasm
  args: ["--limit", "1000"]
  env_vars:
    - ["RUST_LOG", "info"]
  limits:
    max_fuel: 25000000
    max_memory_bytes: 33554432
    max_storage_bytes: 10485760
    timeout_ms: 15000
    max_output_bytes: 1048576
  network_policy: none
  capabilities:
    architectures: ["aarch64", "x86_64"]
    min_ram_mb: 512
    min_battery_pct: 35
    require_charging: true
    require_unmetered_network: true
    max_thermal_level: MODERATE
  retry:
    max_retries: 3
    initial_backoff_ms: 1000
  verification:
    type: single_node
  priority: High
"#;

    // 1. Parse and validate YAML manifest
    let manifest = DeveloperWorkloadManifest::from_yaml_str(yaml_manifest)
        .expect("Valid YAML manifest failed to parse");
    assert_eq!(manifest.api_version, "spaas.io/v1");
    assert_eq!(manifest.kind, "Workload");
    assert_eq!(manifest.metadata.name, "edge-prime-sieve");
    assert_eq!(manifest.metadata.version, "1.2.0");
    assert_eq!(manifest.spec.limits.max_fuel, 25_000_000);
    assert!(manifest.spec.capabilities.require_charging);
    assert_eq!(manifest.spec.priority, WorkloadPriority::High);

    // 2. Synthesize test wasm bytecode for execution
    let wat = r#"
        (module
            (memory (export "memory") 1)
            (func (export "_start"))
        )
    "#;
    let wasm_bytes = wat::parse_str(wat).unwrap();
    let hash = sha256_hex(&wasm_bytes);

    let spec = WorkloadSpec {
        workload_id: Uuid::new_v4(),
        spec_version: manifest.metadata.version,
        name: manifest.metadata.name,
        runtime: manifest.spec.runtime,
        artifact_sha256: hash.clone(),
        artifact_size_bytes: wasm_bytes.len() as u64,
        artifact_uri: "inline://sieve".into(),
        entrypoint: manifest.spec.entrypoint,
        args: manifest.spec.args,
        env_vars: manifest.spec.env_vars,
        limits: manifest.spec.limits,
        network_policy: manifest.spec.network_policy,
        required_capabilities: manifest.spec.capabilities,
        retry_policy: manifest.spec.retry,
        verification_policy: manifest.spec.verification,
        priority: manifest.spec.priority,
        submitter_signature: "sig".into(),
        submitter_pubkey: "pub".into(),
        created_at_ms: chrono::Utc::now().timestamp_millis(),
    };

    // 3. Execute in runtime sandbox
    let runtime = WasmWasiRuntime::new();
    let node_key = KeyPair::generate();
    let node_id = Uuid::new_v4();

    let ctx = ExecutionContext {
        spec: &spec,
        wasm_bytes: &wasm_bytes,
        node_id,
        node_keypair: &node_key,
    };

    let result = runtime.execute(ctx).await.expect("Execution failed");
    assert_eq!(result.exit_code, 0);
    assert!(result.fuel_consumed > 0);
}

#[test]
fn test_developer_manifest_invalid_version_rejected() {
    let invalid_manifest = r#"
apiVersion: spaas.io/v2-unsupported
kind: Workload
metadata:
  name: test
spec:
  binary: ./app.wasm
"#;
    let res = DeveloperWorkloadManifest::from_yaml_str(invalid_manifest);
    assert!(res.is_err(), "Unsupported apiVersion must be rejected");
}
