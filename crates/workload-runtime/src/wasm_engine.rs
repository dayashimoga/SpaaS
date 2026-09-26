use crate::error::RuntimeError;
use crate::traits::{ExecutionContext, WorkloadRuntime};
use crate::wasi_host::{link_sandboxed_wasi, HostState};
use async_trait::async_trait;
use spaas_protocol::job::JobResult;
use spaas_protocol::workload::{RuntimeType, WorkloadSpec};
use spaas_security::hash::verify_sha256;
use spaas_security::signing::sign_job_result;
use std::time::Instant;
use uuid::Uuid;
use wasmi::{Config, Engine, Linker, Module, Store};

pub struct WasmWasiRuntime {
    engine: Engine,
}

impl WasmWasiRuntime {
    pub fn new() -> Self {
        let mut config = Config::default();
        config.consume_fuel(true);
        let engine = Engine::new(&config);
        Self { engine }
    }
}

impl Default for WasmWasiRuntime {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl WorkloadRuntime for WasmWasiRuntime {
    fn runtime_type(&self) -> RuntimeType {
        RuntimeType::WasmWasi
    }

    fn validate_spec(&self, spec: &WorkloadSpec) -> Result<(), RuntimeError> {
        if spec.runtime != RuntimeType::WasmWasi {
            return Err(RuntimeError::CompilationFailed(format!(
                "Unsupported runtime type {:?}",
                spec.runtime
            )));
        }
        if spec.limits.max_fuel == 0 {
            return Err(RuntimeError::OutOfFuel { fuel_limit: 0 });
        }
        if spec.limits.timeout_ms == 0 {
            return Err(RuntimeError::Timeout { timeout_ms: 0 });
        }
        Ok(())
    }

    async fn execute(&self, ctx: ExecutionContext<'_>) -> Result<JobResult, RuntimeError> {
        self.validate_spec(ctx.spec)?;

        // 1. Verify artifact SHA-256 integrity before execution
        verify_sha256(ctx.wasm_bytes, &ctx.spec.artifact_sha256).map_err(|e| {
            RuntimeError::ArtifactVerificationFailed(format!("SHA-256 check failed: {e}"))
        })?;

        // 2. Compile module
        let module = Module::new(&self.engine, ctx.wasm_bytes)
            .map_err(|e| RuntimeError::CompilationFailed(format!("Module parse failed: {e}")))?;

        // 3. Setup sandboxed host state
        let host_state = HostState::new(
            ctx.spec.limits.max_output_bytes,
            ctx.spec.limits.max_fuel,
            ctx.spec.args.clone(),
            ctx.spec.env_vars.clone(),
        );

        let mut store = Store::new(&self.engine, host_state);
        store
            .set_fuel(ctx.spec.limits.max_fuel)
            .map_err(|e| RuntimeError::Internal(format!("Failed to set fuel: {e}")))?;

        let mut linker = Linker::new(&self.engine);
        link_sandboxed_wasi(&mut linker)
            .map_err(|e| RuntimeError::Internal(format!("Failed to link WASI: {e}")))?;

        // 4. Instantiate module
        let instance = linker
            .instantiate(&mut store, &module)
            .map_err(|e| RuntimeError::CompilationFailed(format!("Instantiation failed: {e}")))?
            .start(&mut store)
            .map_err(|e| RuntimeError::Trap(format!("Start trap: {e}")))?;

        // 5. Locate entrypoint: "_start" or custom entrypoint
        let entry_name = if ctx.spec.entrypoint.is_empty() {
            "_start"
        } else {
            &ctx.spec.entrypoint
        };

        let start_func = instance
            .get_typed_func::<(), ()>(&store, entry_name)
            .or_else(|_| instance.get_typed_func::<(), ()>(&store, "_start"))
            .map_err(|_| RuntimeError::EntrypointNotFound(entry_name.to_string()))?;

        // 6. Execute with deterministic timeout watchdog
        let timeout_duration = std::time::Duration::from_millis(ctx.spec.limits.timeout_ms);
        let start_time = Instant::now();

        let run_res = tokio::time::timeout(timeout_duration, async {
            // Execution on blocking thread pool to avoid blocking async worker
            tokio::task::spawn_blocking(move || {
                let call_res = start_func.call(&mut store, ());
                let remaining_fuel = store.get_fuel().unwrap_or(0);
                let host = store.into_data();
                (call_res, remaining_fuel, host)
            })
            .await
        })
        .await;

        let wall_time_ms = start_time.elapsed().as_millis() as u64;

        let (call_res, remaining_fuel, host) = match run_res {
            Ok(Ok(tuple)) => tuple,
            Ok(Err(join_err)) => {
                return Err(RuntimeError::Internal(format!(
                    "Execution task panicked: {join_err}"
                )));
            }
            Err(_) => {
                return Err(RuntimeError::Timeout {
                    timeout_ms: ctx.spec.limits.timeout_ms,
                });
            }
        };

        let fuel_consumed = ctx.spec.limits.max_fuel.saturating_sub(remaining_fuel);

        // Check if error was due to out of fuel
        let exit_code = match call_res {
            Ok(_) => host.exit_code.unwrap_or(0),
            Err(e) => {
                let err_str = e.to_string();
                if err_str.contains("fuel") || remaining_fuel == 0 {
                    return Err(RuntimeError::OutOfFuel {
                        fuel_limit: ctx.spec.limits.max_fuel,
                    });
                }
                // Check if proc_exit was called with exit code
                if let Some(code) = host.exit_code {
                    code
                } else {
                    return Err(RuntimeError::Trap(format!("Execution trapped: {err_str}")));
                }
            }
        };

        let stdout = String::from_utf8_lossy(&host.stdout).to_string();
        let stderr = String::from_utf8_lossy(&host.stderr).to_string();

        let result_digest = JobResult::compute_digest(exit_code, &stdout, &stderr, fuel_consumed);

        let mut job_result = JobResult {
            result_id: Uuid::new_v4(),
            job_id: ctx.spec.workload_id,
            node_id: ctx.node_id,
            exit_code,
            stdout,
            stderr,
            result_digest,
            fuel_consumed,
            wall_time_ms,
            peak_memory_bytes: 64 * 1024, // baseline linear memory page
            node_signature: String::new(),
            completed_at_ms: chrono::Utc::now().timestamp_millis(),
        };

        // 7. Cryptographically seal result with node private key
        sign_job_result(ctx.node_keypair, &mut job_result);

        Ok(job_result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use spaas_protocol::workload::*;
    use spaas_security::hash::sha256_hex;
    use spaas_security::keys::KeyPair;

    // Smallest valid WebAssembly module with _start export:
    // (module (memory (export "memory") 1) (func (export "_start")))
    fn dummy_wasm_bytes() -> Vec<u8> {
        let wat = r#"
            (module
                (memory (export "memory") 1)
                (func (export "_start"))
            )
        "#;
        wat::parse_str(wat).expect("failed to parse WAT")
    }

    #[tokio::test]
    async fn test_wasm_execution_success() {
        let wasm = dummy_wasm_bytes();
        let sha = sha256_hex(&wasm);

        let spec = WorkloadSpec {
            workload_id: Uuid::new_v4(),
            spec_version: "1.0.0".into(),
            name: "test_dummy".into(),
            runtime: RuntimeType::WasmWasi,
            artifact_sha256: sha,
            artifact_size_bytes: wasm.len() as u64,
            artifact_uri: "memory://dummy.wasm".into(),
            entrypoint: "_start".into(),
            args: vec![],
            env_vars: vec![],
            limits: ResourceLimits {
                max_fuel: 10_000,
                max_memory_bytes: 1024 * 1024,
                max_storage_bytes: 1024,
                timeout_ms: 5000,
                max_output_bytes: 1024,
            },
            network_policy: NetworkPolicy::None,
            required_capabilities: RequiredCapabilities::default(),
            dimension_weights: spaas_protocol::workload::WorkloadDimensionWeights::default(),
            retry_policy: RetryPolicy::default(),
            verification_policy: VerificationPolicy::SingleNode,
            priority: WorkloadPriority::Normal,
            submitter_signature: "sig".into(),
            submitter_pubkey: "pub".into(),
            created_at_ms: 1000,
            ..Default::default()
        };

        let node_keys = KeyPair::generate();
        let runtime = WasmWasiRuntime::new();
        let ctx = ExecutionContext {
            spec: &spec,
            wasm_bytes: &wasm,
            node_id: Uuid::new_v4(),
            node_keypair: &node_keys,
        };

        let result = runtime.execute(ctx).await.unwrap();
        assert_eq!(result.exit_code, 0);
        assert!(!result.node_signature.is_empty());
        assert!(
            spaas_security::signing::verify_job_result(&result, &node_keys.public_key_hex())
                .is_ok()
        );
    }

    #[tokio::test]
    async fn test_infinite_loop_fuel_exhaustion() {
        // (module (memory (export "memory") 1) (func (export "_start") (loop (br 0))))
        let wat = r#"
            (module
                (memory (export "memory") 1)
                (func (export "_start")
                    (loop (br 0))
                )
            )
        "#;
        let wasm = wat::parse_str(wat).expect("failed to parse WAT");
        let sha = sha256_hex(&wasm);

        let spec = WorkloadSpec {
            workload_id: Uuid::new_v4(),
            spec_version: "1.0.0".into(),
            name: "infinite_loop".into(),
            runtime: RuntimeType::WasmWasi,
            artifact_sha256: sha,
            artifact_size_bytes: wasm.len() as u64,
            artifact_uri: "memory://inf.wasm".into(),
            entrypoint: "_start".into(),
            args: vec![],
            env_vars: vec![],
            limits: ResourceLimits {
                max_fuel: 500, // Very low fuel limit
                max_memory_bytes: 1024 * 1024,
                max_storage_bytes: 1024,
                timeout_ms: 5000,
                max_output_bytes: 1024,
            },
            network_policy: NetworkPolicy::None,
            required_capabilities: RequiredCapabilities::default(),
            dimension_weights: spaas_protocol::workload::WorkloadDimensionWeights::default(),
            retry_policy: RetryPolicy::default(),
            verification_policy: VerificationPolicy::SingleNode,
            priority: WorkloadPriority::Normal,
            submitter_signature: "sig".into(),
            submitter_pubkey: "pub".into(),
            created_at_ms: 1000,
            ..Default::default()
        };

        let node_keys = KeyPair::generate();
        let runtime = WasmWasiRuntime::new();
        let ctx = ExecutionContext {
            spec: &spec,
            wasm_bytes: &wasm,
            node_id: Uuid::new_v4(),
            node_keypair: &node_keys,
        };

        let err = runtime.execute(ctx).await.unwrap_err();
        assert!(matches!(err, RuntimeError::OutOfFuel { .. }));
    }

    #[tokio::test]
    async fn test_wasm_runtime_validation_failures() {
        let runtime = WasmWasiRuntime::new();
        let wasm = vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
        let sha = sha256_hex(&wasm);

        // 1. Zero fuel
        let mut spec = WorkloadSpec {
            artifact_sha256: sha.clone(),
            ..Default::default()
        };
        spec.limits.max_fuel = 0;
        spec.limits.timeout_ms = 1000;
        let node_keys = KeyPair::generate();
        let ctx = ExecutionContext {
            spec: &spec,
            wasm_bytes: &wasm,
            node_id: Uuid::new_v4(),
            node_keypair: &node_keys,
        };
        assert!(matches!(
            runtime.execute(ctx).await.unwrap_err(),
            RuntimeError::OutOfFuel { .. }
        ));

        // 2. Zero timeout
        spec.limits.max_fuel = 1000;
        spec.limits.timeout_ms = 0;
        let ctx2 = ExecutionContext {
            spec: &spec,
            wasm_bytes: &wasm,
            node_id: Uuid::new_v4(),
            node_keypair: &node_keys,
        };
        assert!(matches!(
            runtime.execute(ctx2).await.unwrap_err(),
            RuntimeError::Timeout { .. }
        ));

        // 3. Artifact verification failed (tampered sha)
        spec.limits.timeout_ms = 1000;
        spec.artifact_sha256 = "invalid_hash_123".into();
        let ctx3 = ExecutionContext {
            spec: &spec,
            wasm_bytes: &wasm,
            node_id: Uuid::new_v4(),
            node_keypair: &node_keys,
        };
        assert!(matches!(
            runtime.execute(ctx3).await.unwrap_err(),
            RuntimeError::ArtifactVerificationFailed(_)
        ));

        // 4. Missing entrypoint
        spec.artifact_sha256 = sha.clone();
        spec.entrypoint = "non_existent_fn".into();
        let ctx4 = ExecutionContext {
            spec: &spec,
            wasm_bytes: &wasm,
            node_id: Uuid::new_v4(),
            node_keypair: &node_keys,
        };
        assert!(matches!(
            runtime.execute(ctx4).await.unwrap_err(),
            RuntimeError::EntrypointNotFound(_)
        ));

        // 5. Unsupported runtime type
        spec.entrypoint = "_start".into();
        spec.runtime = RuntimeType::NativeSandbox;
        let ctx5 = ExecutionContext {
            spec: &spec,
            wasm_bytes: &wasm,
            node_id: Uuid::new_v4(),
            node_keypair: &node_keys,
        };
        assert!(matches!(
            runtime.execute(ctx5).await.unwrap_err(),
            RuntimeError::CompilationFailed(_)
        ));

        // 6. Malformed bytecode
        spec.runtime = RuntimeType::WasmWasi;
        let bad_wasm = vec![0x00, 0x61, 0x73, 0x6d, 0xff, 0xff, 0xff, 0xff];
        spec.artifact_sha256 = sha256_hex(&bad_wasm);
        let ctx6 = ExecutionContext {
            spec: &spec,
            wasm_bytes: &bad_wasm,
            node_id: Uuid::new_v4(),
            node_keypair: &node_keys,
        };
        assert!(matches!(
            runtime.execute(ctx6).await.unwrap_err(),
            RuntimeError::CompilationFailed(_)
        ));
    }

    #[tokio::test]
    async fn test_wasm_trap_execution() {
        let wat = r#"
            (module
                (memory (export "memory") 1)
                (func (export "_start")
                    (unreachable)
                )
            )
        "#;
        let wasm = wat::parse_str(wat).expect("parse WAT");
        let sha = sha256_hex(&wasm);

        let spec = WorkloadSpec {
            workload_id: Uuid::new_v4(),
            spec_version: "1.0.0".into(),
            name: "trap_job".into(),
            runtime: RuntimeType::WasmWasi,
            artifact_sha256: sha,
            artifact_size_bytes: wasm.len() as u64,
            artifact_uri: "memory://trap.wasm".into(),
            entrypoint: "_start".into(),
            args: vec![],
            env_vars: vec![],
            limits: ResourceLimits::default(),
            network_policy: NetworkPolicy::None,
            required_capabilities: RequiredCapabilities::default(),
            dimension_weights: spaas_protocol::workload::WorkloadDimensionWeights::default(),
            retry_policy: RetryPolicy::default(),
            verification_policy: VerificationPolicy::SingleNode,
            priority: WorkloadPriority::Normal,
            submitter_signature: "sig".into(),
            submitter_pubkey: "pub".into(),
            created_at_ms: 1000,
            ..Default::default()
        };

        let node_keys = KeyPair::generate();
        let runtime = WasmWasiRuntime::new();
        let ctx = ExecutionContext {
            spec: &spec,
            wasm_bytes: &wasm,
            node_id: Uuid::new_v4(),
            node_keypair: &node_keys,
        };

        let err = runtime.execute(ctx).await.unwrap_err();
        assert!(matches!(err, RuntimeError::Trap(_)));
    }

    #[test]
    fn test_runtime_error_formatting() {
        let errs = vec![
            RuntimeError::OutOfFuel { fuel_limit: 100 },
            RuntimeError::Timeout { timeout_ms: 50 },
            RuntimeError::MemoryLimitExceeded {
                requested_bytes: 200,
                max_bytes: 100,
            },
            RuntimeError::OutputBufferExceeded { max_bytes: 512 },
            RuntimeError::ArtifactVerificationFailed("bad hash".into()),
            RuntimeError::CompilationFailed("bad wasm".into()),
            RuntimeError::Trap("unreachable".into()),
            RuntimeError::EntrypointNotFound("_start".into()),
            RuntimeError::SyscallDenied("open".into()),
            RuntimeError::Internal("crash".into()),
        ];
        for err in errs {
            assert!(!format!("{}", err).is_empty());
        }
    }

    #[tokio::test]
    async fn test_real_catalog_workload_binaries_execution() {
        let runtime = WasmWasiRuntime::new();
        let node_keys = KeyPair::generate();

        let fixtures = [
            (
                "fixtures/hello_wasi_clean.wasm",
                "Hello from SPaaS Universal Edge Compute Fabric!",
            ),
            (
                "fixtures/sha256_hasher.wasm",
                "SPaaS WASM Sandbox: SHA-256 Cryptographic Benchmark",
            ),
            (
                "fixtures/prime_sieve.wasm",
                "SPaaS WASM Sandbox: Prime Sieve",
            ),
            (
                "fixtures/matrix_compute.wasm",
                "SPaaS WASM Sandbox: Matrix Multiplication",
            ),
        ];

        for (path, expected_stdout) in fixtures {
            // Path relative to workspace root or crate root
            let full_path = if std::path::Path::new(path).exists() {
                path.to_string()
            } else {
                format!("../../{}", path)
            };
            let wasm =
                std::fs::read(&full_path).unwrap_or_else(|_| panic!("failed to read {full_path}"));
            let hash = sha256_hex(&wasm);

            let spec = WorkloadSpec {
                workload_id: Uuid::new_v4(),
                spec_version: "1.0.0".into(),
                name: "catalog_test".into(),
                runtime: RuntimeType::WasmWasi,
                artifact_sha256: hash,
                artifact_size_bytes: wasm.len() as u64,
                artifact_uri: "local://fixture".into(),
                entrypoint: "_start".into(),
                args: vec![],
                env_vars: vec![],
                limits: ResourceLimits {
                    max_fuel: 50_000_000,
                    max_memory_bytes: 16 * 1024 * 1024,
                    max_storage_bytes: 10 * 1024 * 1024,
                    timeout_ms: 10_000,
                    max_output_bytes: 1024 * 1024,
                },
                network_policy: NetworkPolicy::None,
                required_capabilities: RequiredCapabilities::default(),
                dimension_weights: Default::default(),
                retry_policy: RetryPolicy::default(),
                verification_policy: VerificationPolicy::SingleNode,
                priority: WorkloadPriority::Normal,
                submitter_signature: "sig".into(),
                submitter_pubkey: "pub".into(),
                created_at_ms: 1000,
                ..Default::default()
            };

            let ctx = ExecutionContext {
                spec: &spec,
                wasm_bytes: &wasm,
                node_id: Uuid::new_v4(),
                node_keypair: &node_keys,
            };

            let result = runtime
                .execute(ctx)
                .await
                .unwrap_or_else(|e| panic!("execution failed for {full_path}: {e}"));
            assert_eq!(result.exit_code, 0, "Non-zero exit code for {full_path}");
            assert!(result.fuel_consumed > 0, "No fuel consumed for {full_path}");
            assert!(
                result.stdout.contains(expected_stdout),
                "Expected stdout for {full_path} to contain '{}', got: '{}'",
                expected_stdout,
                result.stdout
            );
        }
    }
}
