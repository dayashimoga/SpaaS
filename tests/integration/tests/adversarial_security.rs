use spaas_integration_tests::make_test_wat_bytes;
use spaas_node_agent::NodeAgent;
use spaas_protocol::job::JobResult;
use spaas_protocol::node::*;
use spaas_protocol::rpc::JobDispatchMessage;
use spaas_protocol::workload::*;
use spaas_runtime::RuntimeError;
use spaas_security::hash::sha256_hex;
use spaas_security::keys::KeyPair;
use spaas_security::sanitization::{sanitize_sandboxed_path, validate_identifier};
use spaas_security::signing::{sign_job_result, sign_workload, verify_workload};
use spaas_security::token::{AuthRole, AuthToken};
use spaas_verification::VerificationEngine;
use std::path::PathBuf;
use uuid::Uuid;

#[tokio::test]
async fn test_adversarial_infinite_loop_mitigation() {
    let mut node = NodeAgent::new(
        NodeHardwareCapabilities::default(),
        ProviderPolicy::default(),
        false,
    );

    // Hostile infinite loop module
    let wat = r#"
        (module
            (memory (export "memory") 1)
            (func (export "_start")
                (loop (br 0))
            )
        )
    "#;
    let wasm = make_test_wat_bytes(wat);
    let dev_key = KeyPair::generate();

    let mut spec = WorkloadSpec {
        workload_id: Uuid::new_v4(),
        spec_version: "1.0.0".into(),
        name: "hostile_infinite_loop".into(),
        runtime: RuntimeType::WasmWasi,
        artifact_sha256: sha256_hex(&wasm),
        artifact_size_bytes: wasm.len() as u64,
        artifact_uri: "inline".into(),
        entrypoint: "_start".into(),
        args: vec![],
        env_vars: vec![],
        limits: ResourceLimits {
            max_fuel: 1_000, // Strict gas ceiling
            max_memory_bytes: 1024 * 1024,
            max_storage_bytes: 1024,
            timeout_ms: 3000,
            max_output_bytes: 1024,
        },
        network_policy: NetworkPolicy::None,
        required_capabilities: RequiredCapabilities::default(),
        retry_policy: RetryPolicy::default(),
        verification_policy: VerificationPolicy::SingleNode,
        priority: WorkloadPriority::Normal,
        submitter_signature: String::new(),
        submitter_pubkey: String::new(),
        created_at_ms: chrono::Utc::now().timestamp_millis(),
    };
    sign_workload(&dev_key, &mut spec);

    let dispatch = JobDispatchMessage {
        job_id: spec.workload_id,
        lease_id: Uuid::new_v4(),
        lease_expires_at_ms: chrono::Utc::now().timestamp_millis() + 30_000,
        spec,
        wasm_bytes: Some(wasm),
        dispatched_at_ms: chrono::Utc::now().timestamp_millis(),
    };

    let result = node.execute_dispatched_job(dispatch).await;
    assert!(matches!(result, Err(RuntimeError::OutOfFuel { .. })));
}

#[tokio::test]
async fn test_adversarial_tampered_workload_rejected() {
    let dev_key = KeyPair::generate();
    let wasm =
        make_test_wat_bytes(r#"(module (memory (export "memory") 1) (func (export "_start")))"#);

    let mut spec = WorkloadSpec {
        workload_id: Uuid::new_v4(),
        spec_version: "1.0.0".into(),
        name: "tamper_target".into(),
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
        retry_policy: RetryPolicy::default(),
        verification_policy: VerificationPolicy::SingleNode,
        priority: WorkloadPriority::Normal,
        submitter_signature: String::new(),
        submitter_pubkey: String::new(),
        created_at_ms: chrono::Utc::now().timestamp_millis(),
    };
    sign_workload(&dev_key, &mut spec);

    // Initial check must succeed
    assert!(verify_workload(&spec).is_ok());

    // Attacker tampers with limits (e.g. attempting to grant themselves unlimited fuel)
    spec.limits.max_fuel = 999_999_999;
    assert!(verify_workload(&spec).is_err());
}

#[tokio::test]
async fn test_adversarial_forged_node_result_rejected() {
    let verification = VerificationEngine::new();
    let honest_node_key = KeyPair::generate();
    let malicious_attacker_key = KeyPair::generate();

    let digest = JobResult::compute_digest(0, "legitimate output", "", 500);

    let mut forged_result = JobResult {
        result_id: Uuid::new_v4(),
        job_id: Uuid::new_v4(),
        node_id: Uuid::new_v4(),
        exit_code: 0,
        stdout: "legitimate output".into(),
        stderr: "".into(),
        result_digest: digest,
        fuel_consumed: 500,
        wall_time_ms: 10,
        peak_memory_bytes: 65536,
        node_signature: String::new(),
        completed_at_ms: chrono::Utc::now().timestamp_millis(),
    };

    // Attacker attempts to sign the result with their own untrusted key
    sign_job_result(&malicious_attacker_key, &mut forged_result);

    // Verification against the assigned honest node public key MUST fail
    let check =
        verification.verify_single_result(&forged_result, &honest_node_key.public_key_hex());
    assert!(check.is_err());
}

#[tokio::test]
async fn test_adversarial_byzantine_quorum_detection() {
    let verification = VerificationEngine::new();
    let job_id = Uuid::new_v4();

    let node1 = Uuid::new_v4();
    let node2 = Uuid::new_v4();
    let byzantine_node = Uuid::new_v4();

    let r1 = JobResult {
        result_id: Uuid::new_v4(),
        job_id,
        node_id: node1,
        exit_code: 0,
        stdout: "Result=42\n".into(),
        stderr: "".into(),
        result_digest: "digest_correct".into(),
        fuel_consumed: 1000,
        wall_time_ms: 15,
        peak_memory_bytes: 65536,
        node_signature: "sig1".into(),
        completed_at_ms: 1000,
    };

    let mut r2 = r1.clone();
    r2.result_id = Uuid::new_v4();
    r2.node_id = node2;

    let mut r_byzantine = r1.clone();
    r_byzantine.result_id = Uuid::new_v4();
    r_byzantine.node_id = byzantine_node;
    r_byzantine.stdout = "Result=666\n".into(); // Poisoned result
    r_byzantine.result_digest = "digest_poisoned".into();

    let results = vec![r1, r2, r_byzantine];
    let outcome = verification.verify_redundant_quorum(&results, 2).unwrap();

    assert!(outcome.is_consensus_reached);
    assert_eq!(outcome.agreed_digest, "digest_correct");
    assert_eq!(outcome.agreeing_nodes.len(), 2);
    // Dissenting Byzantine node identified
    assert_eq!(outcome.dissenting_nodes, vec![byzantine_node]);
}

#[test]
fn test_path_traversal_and_injection_defenses() {
    let base = PathBuf::from("/spaaS/sandbox");
    assert!(sanitize_sandboxed_path(&base, "../../etc/shadow").is_err());
    assert!(sanitize_sandboxed_path(&base, "/etc/passwd").is_err());
    assert!(sanitize_sandboxed_path(&base, "safe/workload.wasm").is_ok());

    assert!(validate_identifier("safe-job-123").is_ok());
    assert!(validate_identifier("rm -rf /").is_err());
    assert!(validate_identifier("; cat /etc/passwd").is_err());
}

#[test]
fn test_expired_auth_token_rejected() {
    let server_key = KeyPair::generate();
    let authority_pub = spaas_security::keys::PublicKey(*server_key.verifying_key());

    // Issue expired token
    let (_, token_str) =
        AuthToken::issue(&server_key, "attacker".into(), AuthRole::WorkerNode, -5000);

    let decoded = AuthToken::decode_and_verify(&token_str, &authority_pub);
    assert!(decoded.is_err());
}
