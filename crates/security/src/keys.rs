use crate::error::SecurityError;
use ed25519_dalek::{SigningKey, VerifyingKey};
use rand::rngs::OsRng;

#[derive(Clone)]
pub struct KeyPair {
    signing_key: SigningKey,
    verifying_key: VerifyingKey,
}

impl KeyPair {
    /// Generates a cryptographically secure fresh Ed25519 keypair
    pub fn generate() -> Self {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();
        Self {
            signing_key,
            verifying_key,
        }
    }

    /// Reconstructs keypair from 32-byte private key seed
    pub fn from_secret_bytes(bytes: &[u8; 32]) -> Self {
        let signing_key = SigningKey::from_bytes(bytes);
        let verifying_key = signing_key.verifying_key();
        Self {
            signing_key,
            verifying_key,
        }
    }

    /// Reconstructs keypair from hex string
    pub fn from_secret_hex(hex_str: &str) -> Result<Self, SecurityError> {
        let bytes = hex::decode(hex_str)
            .map_err(|e| SecurityError::InvalidKey(format!("Hex decode failed: {e}")))?;
        if bytes.len() != 32 {
            return Err(SecurityError::InvalidKey(format!(
                "Invalid secret key length: expected 32 bytes, got {}",
                bytes.len()
            )));
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&bytes);
        Ok(Self::from_secret_bytes(&arr))
    }

    pub fn signing_key(&self) -> &SigningKey {
        &self.signing_key
    }

    pub fn verifying_key(&self) -> &VerifyingKey {
        &self.verifying_key
    }

    /// Returns public key as 32 bytes
    pub fn public_key_bytes(&self) -> [u8; 32] {
        self.verifying_key.to_bytes()
    }

    /// Returns public key as hex string
    pub fn public_key_hex(&self) -> String {
        hex::encode(self.public_key_bytes())
    }

    /// Returns secret key as hex string
    pub fn secret_key_hex(&self) -> String {
        hex::encode(self.signing_key.to_bytes())
    }
}

pub struct PublicKey(pub VerifyingKey);

impl PublicKey {
    pub fn from_hex(hex_str: &str) -> Result<Self, SecurityError> {
        let bytes = hex::decode(hex_str)
            .map_err(|e| SecurityError::InvalidKey(format!("Hex decode failed: {e}")))?;
        if bytes.len() != 32 {
            return Err(SecurityError::InvalidKey(format!(
                "Invalid public key length: expected 32 bytes, got {}",
                bytes.len()
            )));
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&bytes);
        let verifying_key = VerifyingKey::from_bytes(&arr)
            .map_err(|e| SecurityError::InvalidKey(format!("Invalid Ed25519 point: {e}")))?;
        Ok(Self(verifying_key))
    }

    pub fn to_hex(&self) -> String {
        hex::encode(self.0.to_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_keypair_generation_and_serialization() {
        let pair = KeyPair::generate();
        let pub_hex = pair.public_key_hex();
        let sec_hex = pair.secret_key_hex();

        assert_eq!(pub_hex.len(), 64);
        assert_eq!(sec_hex.len(), 64);

        let restored_pair = KeyPair::from_secret_hex(&sec_hex).unwrap();
        assert_eq!(restored_pair.public_key_hex(), pub_hex);

        let public_key = PublicKey::from_hex(&pub_hex).unwrap();
        assert_eq!(public_key.to_hex(), pub_hex);
    }

    #[test]
    fn test_invalid_keys() {
        assert!(KeyPair::from_secret_hex("invalid_hex").is_err());
        assert!(KeyPair::from_secret_hex("aabb").is_err());
        assert!(KeyPair::from_secret_hex(&"00".repeat(31)).is_err());
        assert!(KeyPair::from_secret_hex(&"00".repeat(33)).is_err());
        assert!(PublicKey::from_hex("invalid_hex").is_err());
        assert!(PublicKey::from_hex("aabb").is_err());
        assert!(PublicKey::from_hex(&"00".repeat(31)).is_err());
        assert!(PublicKey::from_hex(&"00".repeat(33)).is_err());
    }
}
