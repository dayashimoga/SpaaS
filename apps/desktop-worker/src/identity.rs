use anyhow::{Context, Result};
use spaas_security::keys::KeyPair;
use std::fs;
use std::path::{Path, PathBuf};

pub struct WorkerIdentity {
    pub keypair: KeyPair,
}

impl WorkerIdentity {
    pub fn default_key_path() -> PathBuf {
        let home = if let Ok(h) = std::env::var("USERPROFILE") {
            PathBuf::from(h)
        } else if let Ok(h) = std::env::var("HOME") {
            PathBuf::from(h)
        } else {
            PathBuf::from(".")
        };
        home.join(".spaas").join("worker_identity.key")
    }

    pub fn load_or_generate(path: Option<&Path>) -> Result<Self> {
        let p = path
            .map(|p| p.to_path_buf())
            .unwrap_or_else(Self::default_key_path);

        if p.exists() {
            let bytes = fs::read(&p).with_context(|| format!("Failed to read key from {:?}", p))?;
            if bytes.len() == 32 {
                let mut seed = [0u8; 32];
                seed.copy_from_slice(&bytes[..32]);
                let keypair = KeyPair::from_secret_bytes(&seed);
                return Ok(Self { keypair });
            }
        }

        // Generate fresh secure Ed25519 keypair
        let keypair = KeyPair::generate();
        if let Some(parent) = p.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&p, keypair.signing_key().to_bytes());

        Ok(Self { keypair })
    }

    pub fn public_key_hex(&self) -> String {
        self.keypair.public_key_hex()
    }
}
