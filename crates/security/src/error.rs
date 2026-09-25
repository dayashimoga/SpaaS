use thiserror::Error;

#[derive(Error, Debug, Clone, PartialEq, Eq)]
pub enum SecurityError {
    #[error("Invalid cryptographic key: {0}")]
    InvalidKey(String),

    #[error("Signature verification failed: {0}")]
    SignatureFailed(String),

    #[error("SHA-256 integrity check failed. Expected {expected}, got {actual}")]
    IntegrityCheckFailed { expected: String, actual: String },

    #[error("Auth token expired at {expired_at}, current time is {now}")]
    TokenExpired { expired_at: i64, now: i64 },

    #[error("Invalid authentication token: {0}")]
    InvalidToken(String),

    #[error("Replay attack detected: nonce {0} has already been consumed")]
    ReplayDetected(String),

    #[error("Path traversal or illegal identifier detected: {0}")]
    IllegalInput(String),

    #[error("Unsupported cryptographic algorithm or curve: {0}")]
    UnsupportedAlgorithm(String),
}
