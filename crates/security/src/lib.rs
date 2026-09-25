pub mod error;
pub mod hash;
pub mod keys;
pub mod sanitization;
pub mod signing;
pub mod token;

pub use error::SecurityError;
pub use hash::{sha256_hex, verify_sha256};
pub use keys::{KeyPair, PublicKey};
pub use sanitization::{sanitize_sandboxed_path, validate_identifier};
pub use signing::{
    sign_job_result, sign_message, sign_workload, verify_job_result, verify_signature,
    verify_workload,
};
pub use token::{AuthClaims, AuthRole, AuthToken};
