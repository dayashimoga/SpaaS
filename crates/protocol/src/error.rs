use thiserror::Error;

#[derive(Error, Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("Invalid state transition from '{from}' to '{to}'")]
    InvalidStateTransition { from: String, to: String },

    #[error("Cryptographic signature verification failed: {0}")]
    SignatureVerificationFailed(String),

    #[error("Artifact or result hash mismatch. Expected {expected}, got {actual}")]
    HashMismatch { expected: String, actual: String },

    #[error("Resource limit exceeded: {0}")]
    ResourceExhausted(String),

    #[error("Execution timed out after {timeout_ms} ms")]
    Timeout { timeout_ms: u64 },

    #[error("No eligible node available matching workload constraints")]
    NoEligibleNodeFound,

    #[error("Node {node_id} is not registered or is offline")]
    NodeUnavailable { node_id: String },

    #[error("Unauthorized action: {0}")]
    Unauthorized(String),

    #[error("Workload validation error: {0}")]
    WorkloadValidationFailed(String),

    #[error("Idempotency conflict: record already processed with key {0}")]
    IdempotencyConflict(String),

    #[error("Verification failed: consensus not reached ({agreed}/{total} matching)")]
    ConsensusFailed { agreed: u32, total: u32 },

    #[error("Internal protocol error: {0}")]
    Internal(String),
}
