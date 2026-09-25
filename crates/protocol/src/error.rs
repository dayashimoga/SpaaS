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

    #[error("Serialization or parsing error: {0}")]
    SerializationError(String),

    #[error("Job lease expired or invalid: {0}")]
    LeaseExpired(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_protocol_error_formatting() {
        let errs = vec![
            ProtocolError::InvalidStateTransition { from: "A".into(), to: "B".into() },
            ProtocolError::SignatureVerificationFailed("bad sig".into()),
            ProtocolError::HashMismatch { expected: "1".into(), actual: "2".into() },
            ProtocolError::ResourceExhausted("mem".into()),
            ProtocolError::Timeout { timeout_ms: 1000 },
            ProtocolError::NoEligibleNodeFound,
            ProtocolError::NodeUnavailable { node_id: "node_1".into() },
            ProtocolError::Unauthorized("denied".into()),
            ProtocolError::WorkloadValidationFailed("invalid".into()),
            ProtocolError::IdempotencyConflict("idem_key".into()),
            ProtocolError::ConsensusFailed { agreed: 1, total: 3 },
            ProtocolError::Internal("crash".into()),
            ProtocolError::SerializationError("bad json".into()),
            ProtocolError::LeaseExpired("lease_1".into()),
        ];

        for err in errs {
            let s = format!("{}", err);
            assert!(!s.is_empty());
        }
    }
}

