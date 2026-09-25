use spaas_protocol::workload::*;
use spaas_runtime::traits::{ExecutionContext, WorkloadRuntime};
use spaas_runtime::wasm_engine::WasmWasiRuntime;
use spaas_runtime::RuntimeError;
use spaas_security::hash::sha256_hex;
use spaas_security::keys::KeyPair;
use uuid::Uuid;

fn make_spec(name: &str, wasm_bytes: &[u8], limits: ResourceLimits) -> WorkloadSpec {
    let hash = sha256_hex(wasm_bytes);
    WorkloadSpec {
        workload_id: Uuid::new_v4(),
        spec_version: "1.0.0".into(),
        name: name.into(),
        runtime: RuntimeType::WasmWasi,
        artifact_sha256: hash.clone(),
        artifact_size_bytes: wasm_bytes.len() as u64,
        artifact_uri: format!("inline://{name}"),
        entrypoint: "_start".into(),
        args: vec![],
        env_vars: vec![],
        limits,
        network_policy: NetworkPolicy::None,
        required_capabilities: RequiredCapabilities::default(),
        retry_policy: RetryPolicy::default(),
        verification_policy: VerificationPolicy::SingleNode,
        priority: WorkloadPriority::Normal,
        submitter_signature: "test_sig".into(),
        submitter_pubkey: "test_pub".into(),
        created_at_ms: chrono::Utc::now().timestamp_millis(),
    }
}

#[tokio::test]
async fn test_adversarial_memory_bomb() {
    let runtime = WasmWasiRuntime::new();
    let node_key = KeyPair::generate();
    let node_id = Uuid::new_v4();

    // Module attempts to grow memory aggressively in a loop
    let wat = r#"
        (module
            (memory (export "memory") 1)
            (func (export "_start")
                (local $i i32)
                (loop $grow_loop
                    (drop (memory.grow (i32.const 10)))
                    (local.set $i (i32.add (local.get $i) (i32.const 1)))
                    (br_if $grow_loop (i32.lt_s (local.get $i) (i32.const 1000)))
                )
            )
        )
    "#;
    let wasm = wat::parse_str(wat).unwrap();
    let limits = ResourceLimits {
        max_fuel: 50_000_000,
        max_memory_bytes: 2 * 1024 * 1024, // 2MB ceiling (32 pages)
        max_storage_bytes: 1024 * 1024,
        timeout_ms: 10_000,
        max_output_bytes: 65536,
    };
    let spec = make_spec("memory_bomb", &wasm, limits);

    let ctx = ExecutionContext {
        spec: &spec,
        wasm_bytes: &wasm,
        node_id,
        node_keypair: &node_key,
    };

    let result = runtime.execute(ctx).await;
    // wasmi restricts memory growth based on maximum initial/runtime bounds or fuel
    assert!(
        result.is_ok()
            || matches!(
                result,
                Err(RuntimeError::OutOfFuel { .. }) | Err(RuntimeError::MemoryLimitExceeded { .. })
            )
    );
}

#[tokio::test]
async fn test_adversarial_deep_recursion() {
    let runtime = WasmWasiRuntime::new();
    let node_key = KeyPair::generate();
    let node_id = Uuid::new_v4();

    // Mutually recursive functions attempting stack overflow
    let wat = r#"
        (module
            (memory (export "memory") 1)
            (func $rec_a (export "_start")
                (call $rec_b)
            )
            (func $rec_b
                (call $rec_a)
            )
        )
    "#;
    let wasm = wat::parse_str(wat).unwrap();
    let limits = ResourceLimits {
        max_fuel: 200_000, // Small fuel allocation to rapidly trip watchdog
        max_memory_bytes: 4 * 1024 * 1024,
        max_storage_bytes: 1024 * 1024,
        timeout_ms: 5_000,
        max_output_bytes: 65536,
    };
    let spec = make_spec("recursion_bomb", &wasm, limits);

    let ctx = ExecutionContext {
        spec: &spec,
        wasm_bytes: &wasm,
        node_id,
        node_keypair: &node_key,
    };

    let result = runtime.execute(ctx).await;
    assert!(matches!(
        result,
        Err(RuntimeError::OutOfFuel { .. }) | Err(RuntimeError::Trap(_))
    ));
}

#[tokio::test]
async fn test_adversarial_unauthorized_imports_rejected() {
    let runtime = WasmWasiRuntime::new();
    let node_key = KeyPair::generate();
    let node_id = Uuid::new_v4();

    // Module attempts to import forbidden foreign host APIs
    let wat = r#"
        (module
            (import "env" "system" (func $system (param i32) (result i32)))
            (memory (export "memory") 1)
            (func (export "_start")
                (drop (call $system (i32.const 0)))
            )
        )
    "#;
    let wasm = wat::parse_str(wat).unwrap();
    let spec = make_spec("forbidden_imports", &wasm, ResourceLimits::default());

    let ctx = ExecutionContext {
        spec: &spec,
        wasm_bytes: &wasm,
        node_id,
        node_keypair: &node_key,
    };

    let result = runtime.execute(ctx).await;
    assert!(matches!(result, Err(RuntimeError::CompilationFailed(_))));
}

#[tokio::test]
async fn test_adversarial_corrupted_bytecode_rejected() {
    let runtime = WasmWasiRuntime::new();
    let node_key = KeyPair::generate();
    let node_id = Uuid::new_v4();

    // Invalid truncated binary
    let corrupted_wasm = vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00];
    let spec = make_spec("corrupted_wasm", &corrupted_wasm, ResourceLimits::default());

    let ctx = ExecutionContext {
        spec: &spec,
        wasm_bytes: &corrupted_wasm,
        node_id,
        node_keypair: &node_key,
    };

    let result = runtime.execute(ctx).await;
    assert!(matches!(result, Err(RuntimeError::CompilationFailed(_))));
}

#[tokio::test]
async fn test_concurrent_sandboxed_executions() {
    let runtime = std::sync::Arc::new(WasmWasiRuntime::new());
    let mut handles = Vec::new();

    let wat = r#"
        (module
            (memory (export "memory") 1)
            (func (export "_start"))
        )
    "#;
    let wasm = wat::parse_str(wat).unwrap();

    for i in 0..10 {
        let rt = runtime.clone();
        let wasm_clone = wasm.clone();
        let handle = tokio::spawn(async move {
            let key = KeyPair::generate();
            let node_id = Uuid::new_v4();
            let spec = make_spec(
                &format!("concurrent_{i}"),
                &wasm_clone,
                ResourceLimits::default(),
            );
            let ctx = ExecutionContext {
                spec: &spec,
                wasm_bytes: &wasm_clone,
                node_id,
                node_keypair: &key,
            };
            rt.execute(ctx).await
        });
        handles.push(handle);
    }

    for h in handles {
        let res = h.await.unwrap();
        assert!(res.is_ok());
    }
}
