use anyhow::{bail, Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug, Serialize)]
struct PairRequest {
    pairing_token: String,
    node_id: String,
    device_name: String,
    device_type: String,
    public_key: String,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct PairResponse {
    status: Option<String>,
    node_id: Option<String>,
    auth_token: Option<String>,
    error: Option<String>,
    message: Option<String>,
}

pub async fn enroll_node(
    endpoint: &str,
    pairing_code: &str,
    node_name: &str,
    public_key_hex: &str,
    existing_node_id: Option<&str>,
) -> Result<(String, String)> {
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .context("Failed to build HTTP client")?;

    let node_id = existing_node_id
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("desktop-{}", Uuid::new_v4()));

    let url = format!("{}/api/v1/devices/pair", endpoint.trim_end_matches('/'));

    let req_body = PairRequest {
        pairing_token: pairing_code.trim().to_string(),
        node_id: node_id.clone(),
        device_name: node_name.to_string(),
        device_type: "Desktop".to_string(),
        public_key: public_key_hex.to_string(),
    };

    let res = client
        .post(&url)
        .json(&req_body)
        .send()
        .await
        .with_context(|| format!("Failed to connect to enrollment endpoint at {}", url))?;

    let status = res.status();
    if !status.is_success() {
        let err_text = res.text().await.unwrap_or_default();
        bail!("Enrollment failed (HTTP {}): {}", status, err_text);
    }

    let body: PairResponse = res
        .json()
        .await
        .context("Failed to parse enrollment response JSON")?;

    if let Some(err) = body.error {
        bail!("Enrollment rejected: {} ({:?})", err, body.message);
    }

    let auth_token = body
        .auth_token
        .context("Enrollment response missing auth_token")?;
    let confirmed_node_id = body.node_id.unwrap_or(node_id);

    Ok((confirmed_node_id, auth_token))
}
