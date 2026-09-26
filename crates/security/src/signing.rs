use crate::error::SecurityError;
use crate::keys::{KeyPair, PublicKey};
use ed25519_dalek::{Signature, Signer, Verifier};
use spaas_protocol::job::JobResult;
use spaas_protocol::workload::WorkloadSpec;

/// Signs arbitrary message bytes using an Ed25519 KeyPair, returning base64 string
pub fn sign_message(keypair: &KeyPair, message: &[u8]) -> String {
    let sig: Signature = keypair.signing_key().sign(message);
    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, sig.to_bytes())
}

/// Verifies Ed25519 base64 signature against a message and public key
pub fn verify_signature(
    public_key: &PublicKey,
    message: &[u8],
    signature_base64: &str,
) -> Result<(), SecurityError> {
    let sig_bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        signature_base64.trim(),
    )
    .map_err(|e| SecurityError::SignatureFailed(format!("Base64 decode failed: {e}")))?;

    if sig_bytes.len() != 64 {
        return Err(SecurityError::SignatureFailed(format!(
            "Invalid signature length: expected 64 bytes, got {}",
            sig_bytes.len()
        )));
    }

    let mut arr = [0u8; 64];
    arr.copy_from_slice(&sig_bytes);
    let signature = Signature::from_bytes(&arr);

    public_key
        .0
        .verify(message, &signature)
        .map_err(|e| SecurityError::SignatureFailed(format!("Cryptographic check failed: {e}")))
}

/// Cryptographically signs a WorkloadSpec with the submitter's private key
pub fn sign_workload(keypair: &KeyPair, spec: &mut WorkloadSpec) {
    let canonical = spec.canonical_bytes_for_signing();
    let sig = sign_message(keypair, &canonical);
    spec.submitter_signature = sig;
    spec.submitter_pubkey = keypair.public_key_hex();
}

/// Verifies that a WorkloadSpec has not been tampered with and was signed by its claimed public key
pub fn verify_workload(spec: &WorkloadSpec) -> Result<(), SecurityError> {
    let pubkey = PublicKey::from_hex(&spec.submitter_pubkey)?;
    let canonical = spec.canonical_bytes_for_signing();
    verify_signature(&pubkey, &canonical, &spec.submitter_signature)
}

/// Cryptographically signs a JobResult with the executing node's private key
pub fn sign_job_result(keypair: &KeyPair, result: &mut JobResult) {
    let digest_bytes = result.result_digest.as_bytes();
    let sig = sign_message(keypair, digest_bytes);
    result.node_signature = sig;
}

/// Verifies that a JobResult was produced and signed by the assigned worker node
pub fn verify_job_result(
    result: &JobResult,
    expected_node_pubkey: &str,
) -> Result<(), SecurityError> {
    // 1. Verify that computed digest matches actual stdout/stderr/fuel/exit_code
    let expected_digest = JobResult::compute_digest(
        result.exit_code,
        &result.stdout,
        &result.stderr,
        result.fuel_consumed,
    );
    if result.result_digest != expected_digest {
        return Err(SecurityError::IntegrityCheckFailed {
            expected: expected_digest,
            actual: result.result_digest.clone(),
        });
    }

    // 2. Verify node Ed25519 signature over result_digest
    let pubkey = PublicKey::from_hex(expected_node_pubkey)?;
    verify_signature(
        &pubkey,
        result.result_digest.as_bytes(),
        &result.node_signature,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use spaas_protocol::workload::*;
    use uuid::Uuid;

    #[test]
    fn test_workload_signing_and_verification() {
        let submitter_key = KeyPair::generate();
        let mut spec = WorkloadSpec {
            workload_id: Uuid::new_v4(),
            spec_version: "1.0.0".into(),
            name: "test_workload".into(),
            runtime: RuntimeType::WasmWasi,
            artifact_sha256: "abcd".into(),
            artifact_size_bytes: 1024,
            artifact_uri: "uri".into(),
            entrypoint: "_start".into(),
            args: vec![],
            env_vars: vec![],
            limits: ResourceLimits::default(),
            network_policy: NetworkPolicy::None,
            required_capabilities: RequiredCapabilities::default(),
            dimension_weights: WorkloadDimensionWeights::default(),
            retry_policy: RetryPolicy::default(),
            verification_policy: VerificationPolicy::SingleNode,
            priority: WorkloadPriority::Normal,
            submitter_signature: String::new(),
            submitter_pubkey: String::new(),
            created_at_ms: 1000,
            ..Default::default()
        };

        sign_workload(&submitter_key, &mut spec);
        assert!(!spec.submitter_signature.is_empty());
        assert_eq!(spec.submitter_pubkey, submitter_key.public_key_hex());

        // Verification must pass
        assert!(verify_workload(&spec).is_ok());

        // Tampering with limits must cause verification failure
        spec.limits.max_fuel = 999_999_999;
        assert!(verify_workload(&spec).is_err());
    }

    #[test]
    fn test_job_result_signing_and_verification() {
        let node_key = KeyPair::generate();
        let digest = JobResult::compute_digest(0, "output text", "", 5000);

        let mut res = JobResult {
            result_id: Uuid::new_v4(),
            job_id: Uuid::new_v4(),
            node_id: Uuid::new_v4(),
            exit_code: 0,
            stdout: "output text".into(),
            stderr: "".into(),
            result_digest: digest,
            fuel_consumed: 5000,
            wall_time_ms: 25,
            peak_memory_bytes: 1024 * 1024,
            node_signature: String::new(),
            completed_at_ms: 2000,
        };

        sign_job_result(&node_key, &mut res);
        assert!(!res.node_signature.is_empty());

        assert!(verify_job_result(&res, &node_key.public_key_hex()).is_ok());

        // Forged stdout should be detected immediately
        res.stdout = "tampered text".into();
        assert!(verify_job_result(&res, &node_key.public_key_hex()).is_err());
    }

    #[test]
    fn test_signature_decoding_and_length_validation() {
        let key = KeyPair::generate();
        let pubkey = PublicKey::from_hex(&key.public_key_hex()).unwrap();
        let msg = b"test message";

        // Invalid base64
        assert!(verify_signature(&pubkey, msg, "!invalid_base64!").is_err());

        // Invalid length (base64 of 32 bytes instead of 64 bytes)
        let short_b64 =
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [0u8; 32]);
        assert!(verify_signature(&pubkey, msg, &short_b64).is_err());

        // Corrupted 64-byte signature
        let corrupt_b64 =
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [0u8; 64]);
        assert!(verify_signature(&pubkey, msg, &corrupt_b64).is_err());
    }
}
