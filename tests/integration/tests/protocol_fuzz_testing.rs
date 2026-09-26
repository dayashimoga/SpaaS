use spaas_protocol::job::*;
use spaas_protocol::metering::*;
use spaas_protocol::node::*;
use spaas_protocol::rpc::*;
use spaas_protocol::workload::*;
use uuid::Uuid;

/// Helper to generate pseudorandom bytes using a linear congruential generator (LCG)
struct PseudoRng {
    state: u64,
}

impl PseudoRng {
    fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next_u32(&mut self) -> u32 {
        self.state = self
            .state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.state >> 32) as u32
    }

    fn next_bytes(&mut self, len: usize) -> Vec<u8> {
        let mut buf = Vec::with_capacity(len);
        for _ in 0..len {
            buf.push((self.next_u32() & 0xFF) as u8);
        }
        buf
    }
}

#[test]
fn test_fuzz_random_garbage_inputs_across_protocol_types() {
    let mut rng = PseudoRng::new(0xDEADBEEFCAFEBABE);

    // Test 1,000 completely random byte slices of varying lengths (1 to 4096 bytes)
    for _ in 0..1000 {
        let len = (rng.next_u32() % 4096 + 1) as usize;
        let garbage = rng.next_bytes(len);

        // Deserialization must NEVER panic; it must gracefully return Err
        let _ = serde_json::from_slice::<WorkloadSpec>(&garbage);
        let _ = serde_json::from_slice::<NodeRecord>(&garbage);
        let _ = serde_json::from_slice::<JobRecord>(&garbage);
        let _ = serde_json::from_slice::<HeartbeatRequest>(&garbage);
        let _ = serde_json::from_slice::<HeartbeatResponse>(&garbage);
        let _ = serde_json::from_slice::<RegisterNodeRequest>(&garbage);
        let _ = serde_json::from_slice::<JobResult>(&garbage);
        let _ = serde_json::from_slice::<MeteringRecord>(&garbage);
    }
}

#[test]
fn test_fuzz_mutation_on_valid_payloads() {
    let mut rng = PseudoRng::new(0x123456789ABCDEF0);

    let sample_spec = WorkloadSpec {
        workload_id: Uuid::new_v4(),
        spec_version: "1.0.0".into(),
        name: "fuzz_target".into(),
        runtime: RuntimeType::WasmWasi,
        artifact_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".into(),
        artifact_size_bytes: 1024,
        artifact_uri: "inline://wasm".into(),
        entrypoint: "_start".into(),
        args: vec!["--param".into(), "123".into()],
        env_vars: vec![],
        limits: ResourceLimits {
            max_fuel: 5000000,
            max_memory_bytes: 8388608,
            max_storage_bytes: 1048576,
            timeout_ms: 10000,
            max_output_bytes: 65536,
        },
        network_policy: NetworkPolicy::None,
        required_capabilities: RequiredCapabilities {
            architectures: vec!["aarch64".into(), "x86_64".into()],
            min_ram_mb: 512,
            min_battery_pct: 20,
            require_charging: true,
            require_unmetered_network: true,
            max_thermal_level: "MODERATE".into(),
            required_accelerator: None,
        },
        retry_policy: RetryPolicy::default(),
        verification_policy: VerificationPolicy::SingleNode,
        priority: WorkloadPriority::Normal,
        dimension_weights: Default::default(),
        submitter_signature: "sig123".into(),
        submitter_pubkey: "pub123".into(),
        created_at_ms: 1727350000000,
        ..Default::default()
    };

    let canonical_json = serde_json::to_vec(&sample_spec).unwrap();

    // Perform 2,000 mutation tests (single bit flips, byte overwrites, truncations, insertions)
    for _ in 0..2000 {
        let mut mutated = canonical_json.clone();
        let mutation_type = rng.next_u32() % 4;
        let pos = (rng.next_u32() as usize) % mutated.len();

        match mutation_type {
            0 => {
                // Bit flip
                let bit = (rng.next_u32() % 8) as u8;
                mutated[pos] ^= 1 << bit;
            }
            1 => {
                // Byte overwrite
                mutated[pos] = (rng.next_u32() & 0xFF) as u8;
            }
            2 => {
                // Truncation
                mutated.truncate(pos);
            }
            _ => {
                // Insert random byte
                mutated.insert(pos, (rng.next_u32() & 0xFF) as u8);
            }
        }

        // Must never panic
        let res = serde_json::from_slice::<WorkloadSpec>(&mutated);
        if let Ok(deserialized) = res {
            // If it happens to remain valid JSON that deserializes, ensure we can re-serialize it safely
            let _ = serde_json::to_string(&deserialized);
        }
    }
}

#[test]
fn test_fuzz_pathological_json_strings() {
    let pathological_inputs = [
        "",
        " ",
        "\0",
        "{}",
        "[]",
        "null",
        "true",
        "false",
        "1234567890123456789012345678901234567890",
        "-99999999999999999999999999999999999999",
        "NaN",
        "Infinity",
        "-Infinity",
        "{\"limits\": {\"max_fuel\": -1}}",
        "{\"limits\": {\"max_memory_bytes\": 99999999999999999999999999999}}",
        "{\"name\": \"\u{0000}\u{FFFF}\u{10FFFF}\"}",
        "[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]",
        "{\"a\": {\"b\": {\"c\": {\"d\": {\"e\": {\"f\": {\"g\": 1}}}}}}}",
    ];

    for input in &pathological_inputs {
        let _ = serde_json::from_str::<WorkloadSpec>(input);
        let _ = serde_json::from_str::<NodeRecord>(input);
        let _ = serde_json::from_str::<JobRecord>(input);
        let _ = serde_json::from_str::<HeartbeatRequest>(input);
        let _ = serde_json::from_str::<RegisterNodeRequest>(input);
    }
}

#[test]
fn test_protocol_serde_roundtrip_invariants() {
    let mut rng = PseudoRng::new(0xCAFE);

    for i in 0..100 {
        let spec = WorkloadSpec {
            workload_id: Uuid::new_v4(),
            spec_version: format!("1.{}.0", i),
            name: format!("workload_{}", i),
            runtime: RuntimeType::WasmWasi,
            artifact_sha256: format!("hash_{}", i),
            artifact_size_bytes: rng.next_u32() as u64,
            artifact_uri: format!("https://cdn.example.com/{}.wasm", i),
            entrypoint: "_start".into(),
            args: vec![format!("arg_{}", i)],
            env_vars: vec![],
            limits: ResourceLimits {
                max_fuel: rng.next_u32() as u64,
                max_memory_bytes: rng.next_u32() as u64,
                max_storage_bytes: 1048576,
                timeout_ms: rng.next_u32() as u64,
                max_output_bytes: 65536,
            },
            network_policy: NetworkPolicy::None,
            required_capabilities: RequiredCapabilities {
                architectures: vec!["aarch64".into()],
                min_ram_mb: (rng.next_u32() % 16384) as u64,
                min_battery_pct: (rng.next_u32() % 100) as u8,
                require_charging: (rng.next_u32() & 1) == 0,
                require_unmetered_network: (rng.next_u32() & 1) == 0,
                max_thermal_level: "MODERATE".into(),
                required_accelerator: None,
            },
            retry_policy: RetryPolicy::default(),
            verification_policy: VerificationPolicy::SingleNode,
            priority: WorkloadPriority::Normal,
            dimension_weights: Default::default(),
            submitter_signature: format!("sig_{}", i),
            submitter_pubkey: format!("pub_{}", i),
            created_at_ms: 1727350000000 + i,
            preferred_regions: vec!["us-west".into()],
            deadline_ms: Some(30000),
            category: "compute".into(),
            max_cost_credits: Some(100),
            data_locality_hint: None,
        };

        let serialized = serde_json::to_string(&spec).unwrap();
        let deserialized: WorkloadSpec = serde_json::from_str(&serialized).unwrap();

        assert_eq!(spec.workload_id, deserialized.workload_id);
        assert_eq!(spec.name, deserialized.name);
        assert_eq!(spec.limits.max_fuel, deserialized.limits.max_fuel);
        assert_eq!(spec.preferred_regions, deserialized.preferred_regions);
        assert_eq!(spec.max_cost_credits, deserialized.max_cost_credits);
    }
}
