use spaas_node_agent::NodeAgent;
use spaas_protocol::node::{NodeHardwareCapabilities, ProviderPolicy};
use spaas_security::keys::PublicKey;
use spaas_security::signing::verify_signature;

#[tokio::test]
async fn test_node_empirical_qualification_microbenchmarks() {
    let mut agent = NodeAgent::new(
        NodeHardwareCapabilities::default(),
        ProviderPolicy::default(),
        false,
    );

    // Initial state has no qualification
    assert!(agent.qualification.is_none());

    // Run microbenchmark qualification suite
    let profile = agent
        .run_qualification()
        .await
        .expect("Qualification benchmark failed");

    // Conformance and execution assertions
    assert!(
        profile.wasm_conformance_passed,
        "WASM conformance check must pass"
    );
    assert!(
        profile.wasi_preview1_passed,
        "WASI Preview 1 check must pass"
    );
    assert!(
        profile.measured_fuel_mips > 0.0,
        "Measured fuel MIPS must be positive"
    );
    assert_eq!(profile.measured_memory_max_pages, 16);
    assert!(!profile.qualification_hash.is_empty());
    assert!(!profile.qualification_signature.is_empty());

    // Verify qualification signature using agent's public key
    let pubkey = PublicKey::from_hex(&agent.public_key_hex()).expect("Invalid public key");
    let verified = verify_signature(
        &pubkey,
        profile.qualification_hash.as_bytes(),
        &profile.qualification_signature,
    );
    assert!(
        verified.is_ok(),
        "Qualification signature must cryptographically verify"
    );

    // Verify agent's to_record snapshot incorporates the qualification profile
    let record = agent.to_record();
    assert!(record.qualification.is_some());
    assert_eq!(
        record.qualification.unwrap().qualification_hash,
        profile.qualification_hash
    );
}
