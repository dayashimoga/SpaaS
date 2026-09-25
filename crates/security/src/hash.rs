use crate::error::SecurityError;
use sha2::{Digest, Sha256};

/// Computes SHA-256 hash of arbitrary bytes and returns lower-case hex string
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

/// Verifies that data matches expected SHA-256 hex string (case-insensitive)
pub fn verify_sha256(data: &[u8], expected_hex: &str) -> Result<(), SecurityError> {
    let actual_hex = sha256_hex(data);
    if !actual_hex.eq_ignore_ascii_case(expected_hex.trim()) {
        return Err(SecurityError::IntegrityCheckFailed {
            expected: expected_hex.to_string(),
            actual: actual_hex,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sha256_computation_and_verification() {
        let bytes = b"hello spaas edge computing";
        let hash = sha256_hex(bytes);
        assert_eq!(hash.len(), 64);
        assert!(verify_sha256(bytes, &hash).is_ok());
        assert!(verify_sha256(b"corrupted bytes", &hash).is_err());
    }
}
