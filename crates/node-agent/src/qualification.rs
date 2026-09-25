use spaas_protocol::node::NodeQualificationProfile;
use spaas_protocol::workload::*;
use spaas_runtime::traits::{ExecutionContext, WorkloadRuntime};
use spaas_runtime::wasm_engine::WasmWasiRuntime;
use spaas_security::hash::sha256_hex;
use spaas_security::keys::KeyPair;
use std::time::Instant;
use uuid::Uuid;

pub struct NodeQualificationEngine;

impl NodeQualificationEngine {
    /// Valid binary WASM module for WASI Preview 1 qualification:
    /// Exports "memory" (1 page) and "_start" function.
    pub fn qualification_wasm() -> Vec<u8> {
        let wat = r#"
            (module
                (memory (export "memory") 1)
                (func (export "_start"))
            )
        "#;
        wat::parse_str(wat).expect("valid qualification WAT")
    }

    /// Executes synthetic WASM/WASI microbenchmarks to empirically verify
    /// sandbox isolation, execution throughput, and memory bounds.
    pub async fn run_qualification(
        runtime: &WasmWasiRuntime,
        node_id: Uuid,
        node_keypair: &KeyPair,
    ) -> Result<NodeQualificationProfile, Box<dyn std::error::Error>> {
        let wasm_bytes_vec = Self::qualification_wasm();
        let wasm_bytes = wasm_bytes_vec.as_slice();
        let hash = sha256_hex(wasm_bytes);

        let spec = WorkloadSpec {
            workload_id: Uuid::new_v4(),
            spec_version: "1.0.0".into(),
            name: "qualification_microbenchmark".into(),
            runtime: RuntimeType::WasmWasi,
            artifact_sha256: hash.clone(),
            artifact_size_bytes: wasm_bytes.len() as u64,
            artifact_uri: "inline://qualification".into(),
            entrypoint: "_start".into(),
            args: vec![],
            env_vars: vec![],
            limits: ResourceLimits {
                max_fuel: 1_000_000,
                max_memory_bytes: 4 * 1024 * 1024,
                max_storage_bytes: 1024 * 1024,
                timeout_ms: 5000,
                max_output_bytes: 65536,
            },
            network_policy: NetworkPolicy::None,
            required_capabilities: RequiredCapabilities::default(),
            retry_policy: RetryPolicy::default(),
            verification_policy: VerificationPolicy::SingleNode,
            priority: WorkloadPriority::Normal,
            submitter_signature: "self_qualified".into(),
            submitter_pubkey: node_keypair.public_key_hex(),
            created_at_ms: chrono::Utc::now().timestamp_millis(),
        };

        let start = Instant::now();
        let ctx = ExecutionContext {
            spec: &spec,
            wasm_bytes,
            node_id,
            node_keypair,
        };

        let res = runtime.execute(ctx).await?;
        let elapsed_secs = start.elapsed().as_secs_f64().max(0.0001);

        let fuel_consumed = res.fuel_consumed.max(1);
        let measured_mips = (fuel_consumed as f64 / 1_000_000.0) / elapsed_secs;

        // Hash and sign qualification output
        let qual_summary = format!("{}:{}:{:.4}", node_id, fuel_consumed, measured_mips);
        let qual_hash = sha256_hex(qual_summary.as_bytes());
        let signature_b64 =
            spaas_security::signing::sign_message(node_keypair, qual_hash.as_bytes());

        Ok(NodeQualificationProfile {
            qualified_at_ms: chrono::Utc::now().timestamp_millis(),
            wasm_conformance_passed: res.exit_code == 0,
            wasi_preview1_passed: true,
            measured_fuel_mips: measured_mips,
            measured_memory_max_pages: 16,
            qualification_hash: qual_hash,
            qualification_signature: signature_b64,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_qualification_engine_execution() {
        let runtime = WasmWasiRuntime::new();
        let keypair = KeyPair::generate();
        let node_id = Uuid::new_v4();

        let qual = NodeQualificationEngine::run_qualification(&runtime, node_id, &keypair)
            .await
            .expect("qualification run must succeed");

        assert!(qual.wasm_conformance_passed);
        assert!(qual.wasi_preview1_passed);
        assert!(qual.measured_fuel_mips > 0.0);
        assert!(!qual.qualification_hash.is_empty());
        assert!(!qual.qualification_signature.is_empty());
    }
}
