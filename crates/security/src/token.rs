use crate::error::SecurityError;
use crate::keys::{KeyPair, PublicKey};
use crate::signing::{sign_message, verify_signature};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthRole {
    WorkerNode,
    Developer,
    Operator,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthClaims {
    pub subject: String,
    pub role: AuthRole,
    pub nonce: Uuid,
    pub issued_at_ms: i64,
    pub expires_at_ms: i64,
}

impl AuthClaims {
    pub fn is_expired(&self, current_time_ms: i64) -> bool {
        current_time_ms > self.expires_at_ms
    }

    pub fn to_canonical_payload(&self) -> String {
        format!(
            "{}:{:?}:{}:{}:{}",
            self.subject, self.role, self.nonce, self.issued_at_ms, self.expires_at_ms
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthToken {
    pub claims: AuthClaims,
    pub signature_base64: String,
}

impl AuthToken {
    /// Issues a new signed AuthToken valid for `duration_ms`
    pub fn issue(
        signer: &KeyPair,
        subject: String,
        role: AuthRole,
        duration_ms: i64,
    ) -> (Self, String) {
        let now = chrono::Utc::now().timestamp_millis();
        let claims = AuthClaims {
            subject,
            role,
            nonce: Uuid::new_v4(),
            issued_at_ms: now,
            expires_at_ms: now + duration_ms,
        };

        let payload = claims.to_canonical_payload();
        let sig = sign_message(signer, payload.as_bytes());

        let token = Self {
            claims,
            signature_base64: sig,
        };

        let serialized = serde_json::to_string(&token).unwrap_or_default();
        let encoded = base64::Engine::encode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            serialized.as_bytes(),
        );

        (token, encoded)
    }

    /// Verifies and decodes a base64url encoded token against authority public key
    pub fn decode_and_verify(
        encoded_token: &str,
        authority_pubkey: &PublicKey,
    ) -> Result<AuthClaims, SecurityError> {
        let json_bytes = base64::Engine::decode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            encoded_token.trim(),
        )
        .map_err(|e| SecurityError::InvalidToken(format!("Base64url decode error: {e}")))?;

        let token: AuthToken = serde_json::from_slice(&json_bytes)
            .map_err(|e| SecurityError::InvalidToken(format!("JSON parsing error: {e}")))?;

        let now = chrono::Utc::now().timestamp_millis();
        if token.claims.is_expired(now) {
            return Err(SecurityError::TokenExpired {
                expired_at: token.claims.expires_at_ms,
                now,
            });
        }

        let payload = token.claims.to_canonical_payload();
        verify_signature(
            authority_pubkey,
            payload.as_bytes(),
            &token.signature_base64,
        )?;

        Ok(token.claims)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_token_issue_and_verify() {
        let authority = KeyPair::generate();
        let authority_pub = PublicKey(authority.verifying_key().clone());

        let (_token, encoded) =
            AuthToken::issue(&authority, "node-123".into(), AuthRole::WorkerNode, 60_000);

        let claims = AuthToken::decode_and_verify(&encoded, &authority_pub).unwrap();
        assert_eq!(claims.subject, "node-123");
        assert_eq!(claims.role, AuthRole::WorkerNode);

        // Expired token test
        let (_expired_token, expired_encoded) =
            AuthToken::issue(&authority, "node-123".into(), AuthRole::WorkerNode, -1000);
        let err = AuthToken::decode_and_verify(&expired_encoded, &authority_pub);
        assert!(matches!(err, Err(SecurityError::TokenExpired { .. })));
    }
}
