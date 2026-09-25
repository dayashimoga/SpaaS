use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeType {
    /// WebAssembly with WASI Preview 1 sandboxing (Default production runtime)
    WasmWasi,
    /// Future extensible AI inference runtime (e.g. ONNX/TFLite)
    AiInference,
    /// Future native sandboxed container (Linux/MicroVM)
    NativeSandbox,
}

impl Default for RuntimeType {
    fn default() -> Self {
        Self::WasmWasi
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceLimits {
    /// Maximum WebAssembly execution fuel (gas) to prevent infinite loops (e.g. 50_000_000)
    pub max_fuel: u64,
    /// Maximum memory allocation ceiling in bytes (e.g. 64 * 1024 * 1024 = 64MB)
    pub max_memory_bytes: u64,
    /// Maximum ephemeral disk storage in bytes
    pub max_storage_bytes: u64,
    /// Hard execution timeout in milliseconds (deterministic watchdog)
    pub timeout_ms: u64,
    /// Maximum stdout/stderr output size in bytes to prevent buffer exhaustion attacks
    pub max_output_bytes: usize,
}

impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            max_fuel: 50_000_000,
            max_memory_bytes: 64 * 1024 * 1024, // 64 MB
            max_storage_bytes: 10 * 1024 * 1024, // 10 MB
            timeout_ms: 30_000,                  // 30 seconds
            max_output_bytes: 1024 * 1024,       // 1 MB
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkPolicy {
    /// Sandboxed execution with zero network access (Strongest isolation)
    None,
    /// Outbound HTTP/HTTPS requests to pre-approved endpoints only
    OutboundRestricted,
    /// Full network access (Requires elevated provider consent)
    Full,
}

impl Default for NetworkPolicy {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequiredCapabilities {
    /// Target CPU architectures (e.g. ["aarch64", "x86_64"])
    pub architectures: Vec<String>,
    /// Minimum free RAM required in megabytes
    pub min_ram_mb: u64,
    /// Minimum battery percentage required (0..100)
    pub min_battery_pct: u8,
    /// Whether node must be plugged into AC / wireless charger
    pub require_charging: bool,
    /// Whether node must be connected to unmetered network (e.g. Wi-Fi / Ethernet)
    pub require_unmetered_network: bool,
    /// Maximum acceptable thermal level string (e.g. "NONE", "LIGHT", "MODERATE")
    pub max_thermal_level: String,
    /// Optional hardware acceleration (e.g. "npu", "gpu", "none")
    pub required_accelerator: Option<String>,
}

impl Default for RequiredCapabilities {
    fn default() -> Self {
        Self {
            architectures: vec!["aarch64".into(), "x86_64".into()],
            min_ram_mb: 256,
            min_battery_pct: 30,
            require_charging: false,
            require_unmetered_network: true,
            max_thermal_level: "MODERATE".into(),
            required_accelerator: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetryPolicy {
    /// Maximum times a failed job may be rescheduled onto a different node
    pub max_retries: u32,
    /// Base backoff delay between retries in milliseconds
    pub initial_backoff_ms: u64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 3,
            initial_backoff_ms: 1000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VerificationPolicy {
    /// Zero verification overhead for best-effort / low-cost jobs
    None,
    /// Single node execution, trusts signature and hash
    SingleNode,
    /// Compares output digest against a known expected SHA-256 digest
    HashMatch {
        expected_digest: String,
    },
    /// Redundant execution with consensus quorum across multiple untrusted nodes.
    /// Invariant: M-of-N protects against non-colluding nodes; it DOES NOT protect against colluding groups.
    MOfN {
        replicas: u32,
        threshold: u32,
    },
    /// Spot check by re-executing on a deterministic verification node
    DeterministicReplay,
    /// Restricts execution only to nodes with high historical reputation
    TrustedNode {
        min_reputation: u32,
    },
    /// Delegated verification via custom external verifier
    CustomVerifier {
        verifier_endpoint: String,
    },
    /// Random spot check (probabilistic second execution)
    SpotCheck {
        probability_pct: u8,
    },
    /// Reserved for hardware TEE/AVF pKVM attestation (currently UNSUPPORTED on non-TEE devices)
    TeeAttested,
}

impl Default for VerificationPolicy {
    fn default() -> Self {
        Self::SingleNode
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[repr(u8)]
pub enum WorkloadPriority {
    Low = 0,
    Normal = 10,
    High = 20,
    Critical = 30,
}

impl Default for WorkloadPriority {
    fn default() -> Self {
        Self::Normal
    }
}

/// Versioned Workload Specification (Section 6)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkloadSpec {
    /// Unique workload identifier (UUID v4)
    pub workload_id: Uuid,
    /// Semver specification version (e.g. "1.0.0")
    pub spec_version: String,
    /// Human-readable workload name
    pub name: String,
    /// Target runtime environment
    pub runtime: RuntimeType,
    /// SHA-256 hash of the binary artifact (e.g. wasm module)
    pub artifact_sha256: String,
    /// Size of binary artifact in bytes
    pub artifact_size_bytes: u64,
    /// URL or storage key where artifact can be retrieved
    pub artifact_uri: String,
    /// Workload entrypoint function name (e.g. "_start" or "run")
    pub entrypoint: String,
    /// Command line arguments passed into sandboxed WASI module
    pub args: Vec<String>,
    /// Environment variables permitted inside sandbox
    pub env_vars: Vec<(String, String)>,
    /// Strict resource constraints
    pub limits: ResourceLimits,
    /// Network connectivity constraints
    pub network_policy: NetworkPolicy,
    /// Scheduling node requirements
    pub required_capabilities: RequiredCapabilities,
    /// Fault tolerance policy
    pub retry_policy: RetryPolicy,
    /// Result integrity policy
    pub verification_policy: VerificationPolicy,
    /// Queue scheduling priority
    pub priority: WorkloadPriority,
    /// Base64-encoded Ed25519 signature of submitter over the canonical spec bytes
    pub submitter_signature: String,
    /// Submitter public key hex or base64
    pub submitter_pubkey: String,
    /// Timestamp of submission (Unix epoch milliseconds)
    pub created_at_ms: i64,
}

impl WorkloadSpec {
    /// Generates canonical bytes representation for cryptographic signing and verification
    pub fn canonical_bytes_for_signing(&self) -> Vec<u8> {
        format!(
            "{}:{}:{}:{}:{}:{}",
            self.workload_id,
            self.spec_version,
            self.artifact_sha256,
            self.limits.max_fuel,
            self.limits.max_memory_bytes,
            self.created_at_ms
        )
        .into_bytes()
    }
}

impl Default for WorkloadSpec {
    fn default() -> Self {
        Self {
            workload_id: Uuid::new_v4(),
            spec_version: "1.0.0".into(),
            name: "default_workload".into(),
            runtime: RuntimeType::WasmWasi,
            artifact_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".into(),
            artifact_size_bytes: 0,
            artifact_uri: "inline://".into(),
            entrypoint: "_start".into(),
            args: vec![],
            env_vars: vec![],
            limits: ResourceLimits::default(),
            network_policy: NetworkPolicy::None,
            required_capabilities: RequiredCapabilities::default(),
            retry_policy: RetryPolicy::default(),
            verification_policy: VerificationPolicy::SingleNode,
            priority: WorkloadPriority::Normal,
            submitter_signature: "".into(),
            submitter_pubkey: "".into(),
            created_at_ms: 1000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestMetadata {
    pub name: String,
    #[serde(default = "default_manifest_version")]
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
}

fn default_manifest_version() -> String {
    "1.0.0".to_string()
}

fn default_wasi_version() -> String {
    "preview1".to_string()
}

fn default_entrypoint() -> String {
    "_start".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestSpec {
    #[serde(default)]
    pub runtime: RuntimeType,
    #[serde(default = "default_wasi_version")]
    pub wasi_version: String,
    #[serde(default = "default_entrypoint")]
    pub entrypoint: String,
    pub binary: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env_vars: Vec<(String, String)>,
    #[serde(default)]
    pub limits: ResourceLimits,
    #[serde(default)]
    pub network_policy: NetworkPolicy,
    #[serde(default)]
    pub capabilities: RequiredCapabilities,
    #[serde(default)]
    pub retry: RetryPolicy,
    #[serde(default)]
    pub verification: VerificationPolicy,
    #[serde(default)]
    pub priority: WorkloadPriority,
}

/// Versioned developer manifest: `spaas.io/v1`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeveloperWorkloadManifest {
    #[serde(rename = "apiVersion")]
    pub api_version: String,
    pub kind: String,
    pub metadata: ManifestMetadata,
    pub spec: ManifestSpec,
}

impl DeveloperWorkloadManifest {
    pub fn from_yaml_str(yaml: &str) -> Result<Self, crate::error::ProtocolError> {
        let manifest: Self = serde_yaml::from_str(yaml).map_err(|e| {
            crate::error::ProtocolError::SerializationError(format!("Invalid YAML manifest: {e}"))
        })?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn from_json_str(json: &str) -> Result<Self, crate::error::ProtocolError> {
        let manifest: Self = serde_json::from_str(json).map_err(|e| {
            crate::error::ProtocolError::SerializationError(format!("Invalid JSON manifest: {e}"))
        })?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn validate(&self) -> Result<(), crate::error::ProtocolError> {
        if self.api_version != "spaas.io/v1" {
            return Err(crate::error::ProtocolError::InvalidStateTransition {
                from: self.api_version.clone(),
                to: "Unsupported apiVersion (expected 'spaas.io/v1')".into(),
            });
        }
        if self.kind != "Workload" {
            return Err(crate::error::ProtocolError::InvalidStateTransition {
                from: self.kind.clone(),
                to: "Unsupported kind (expected 'Workload')".into(),
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_workload_spec_serialization() {
        let spec = WorkloadSpec {
            workload_id: Uuid::new_v4(),
            spec_version: "1.0.0".into(),
            name: "matrix_multiply".into(),
            runtime: RuntimeType::WasmWasi,
            artifact_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".into(),
            artifact_size_bytes: 4096,
            artifact_uri: "spaas://artifacts/sample.wasm".into(),
            entrypoint: "_start".into(),
            args: vec!["--dim".into(), "100".into()],
            env_vars: vec![("RUST_LOG".into(), "info".into())],
            limits: ResourceLimits::default(),
            network_policy: NetworkPolicy::None,
            required_capabilities: RequiredCapabilities::default(),
            retry_policy: RetryPolicy::default(),
            verification_policy: VerificationPolicy::SingleNode,
            priority: WorkloadPriority::High,
            submitter_signature: "sig123".into(),
            submitter_pubkey: "pubkey123".into(),
            created_at_ms: 1727260800000,
        };

        let json = serde_json::to_string_pretty(&spec).unwrap();
        let decoded: WorkloadSpec = serde_json::from_str(&json).unwrap();
        assert_eq!(spec.workload_id, decoded.workload_id);
        assert_eq!(spec.limits.max_fuel, decoded.limits.max_fuel);
        assert_eq!(spec.canonical_bytes_for_signing(), decoded.canonical_bytes_for_signing());
    }

    #[test]
    fn test_developer_manifest_parsing_and_validation() {
        let yaml_content = r#"
apiVersion: spaas.io/v1
kind: Workload
metadata:
  name: test-wasm-workload
spec:
  runtime: wasm_wasi
  entrypoint: _start
  binary: inline://AGFzbQEAAAABBwFgAn9/AX8DAgEABwcBA2FkZAAACgkBBwAgACABags=
  limits:
    max_fuel: 10000000
    max_memory_bytes: 67108864
    max_storage_bytes: 10485760
    timeout_ms: 5000
    max_output_bytes: 1048576
"#;
        let manifest = DeveloperWorkloadManifest::from_yaml_str(yaml_content).unwrap();
        assert_eq!(manifest.metadata.name, "test-wasm-workload");
        assert_eq!(manifest.spec.limits.max_fuel, 10_000_000);

        let json_content = serde_json::to_string(&manifest).unwrap();
        let deser_json = DeveloperWorkloadManifest::from_json_str(&json_content).unwrap();
        assert_eq!(deser_json.metadata.name, manifest.metadata.name);

        // Invalid apiVersion
        let bad_api = yaml_content.replace("apiVersion: spaas.io/v1", "apiVersion: v2");
        assert!(DeveloperWorkloadManifest::from_yaml_str(&bad_api).is_err());

        // Invalid kind
        let bad_kind = yaml_content.replace("kind: Workload", "kind: Pod");
        assert!(DeveloperWorkloadManifest::from_yaml_str(&bad_kind).is_err());
    }

    #[test]
    fn test_policy_variants_serde() {
        let policies = vec![
            VerificationPolicy::None,
            VerificationPolicy::SingleNode,
            VerificationPolicy::HashMatch { expected_digest: "hash_abc".into() },
            VerificationPolicy::MOfN { replicas: 5, threshold: 3 },
            VerificationPolicy::DeterministicReplay,
            VerificationPolicy::TrustedNode { min_reputation: 90 },
            VerificationPolicy::SpotCheck { probability_pct: 10 },
            VerificationPolicy::CustomVerifier { verifier_endpoint: "https://verifier.spaas.dev".into() },
            VerificationPolicy::TeeAttested,
        ];

        for pol in policies {
            let s = serde_json::to_string(&pol).unwrap();
            let d: VerificationPolicy = serde_json::from_str(&s).unwrap();
            assert_eq!(pol, d);
        }

        let priorities = vec![
            WorkloadPriority::Low,
            WorkloadPriority::Normal,
            WorkloadPriority::High,
            WorkloadPriority::Critical,
        ];
        for prio in priorities {
            let s = serde_json::to_string(&prio).unwrap();
            let d: WorkloadPriority = serde_json::from_str(&s).unwrap();
            assert_eq!(prio, d);
        }
    }
}
