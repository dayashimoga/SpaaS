use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const DEFAULT_ENDPOINT: &str = "https://spaas-control-plane.dayashimoga.workers.dev";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerConfig {
    pub node_id: Option<String>,
    pub node_name: String,
    pub control_plane_url: String,
    pub auth_token: Option<String>,
    pub max_concurrent_jobs: u32,
    pub allow_battery_execution: bool,
    pub heartbeat_interval_secs: u64,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        let hostname = match hostname::get() {
            Ok(h) => h.to_string_lossy().to_string(),
            Err(_) => "Desktop-Worker".to_string(),
        };

        Self {
            node_id: None,
            node_name: format!("Desktop-{}", hostname),
            control_plane_url: DEFAULT_ENDPOINT.to_string(),
            auth_token: None,
            max_concurrent_jobs: 2,
            allow_battery_execution: true,
            heartbeat_interval_secs: 5,
        }
    }
}

impl WorkerConfig {
    pub fn default_config_path() -> PathBuf {
        let home = dirs_or_fallback();
        home.join(".spaas").join("worker_config.json")
    }

    pub fn load_or_default(path: Option<&Path>) -> Self {
        let p = path
            .map(|p| p.to_path_buf())
            .unwrap_or_else(Self::default_config_path);

        if p.exists() {
            if let Ok(data) = fs::read_to_string(&p) {
                if let Ok(cfg) = serde_json::from_str::<Self>(&data) {
                    return cfg;
                }
            }
        }
        Self::default()
    }

    pub fn save(&self, path: Option<&Path>) -> Result<()> {
        let p = path
            .map(|p| p.to_path_buf())
            .unwrap_or_else(Self::default_config_path);

        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("Failed to create directory {:?}", parent))?;
        }

        let json = serde_json::to_string_pretty(self)
            .context("Failed to serialize worker configuration")?;
        fs::write(&p, json).with_context(|| format!("Failed to write config to {:?}", p))?;
        Ok(())
    }
}

fn dirs_or_fallback() -> PathBuf {
    if let Ok(h) = std::env::var("USERPROFILE") {
        return PathBuf::from(h);
    }
    if let Ok(h) = std::env::var("HOME") {
        return PathBuf::from(h);
    }
    PathBuf::from(".")
}

mod hostname {
    use std::ffi::OsString;
    pub fn get() -> std::io::Result<OsString> {
        if let Ok(name) = std::env::var("COMPUTERNAME") {
            return Ok(OsString::from(name));
        }
        if let Ok(name) = std::env::var("HOSTNAME") {
            return Ok(OsString::from(name));
        }
        Ok(OsString::from("desktop-node"))
    }
}
