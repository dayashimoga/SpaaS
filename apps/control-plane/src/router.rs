use crate::handlers::*;
use crate::state::AppState;
use axum::{
    extract::Request,
    http::{header, StatusCode},
    middleware::{from_fn, Next},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;

#[derive(Clone)]
pub struct RateLimiterState {
    records: Arc<Mutex<HashMap<IpAddr, (u32, Instant)>>>,
    max_rps: u32,
}

impl RateLimiterState {
    pub fn new(max_rps: u32) -> Self {
        Self {
            records: Arc::new(Mutex::new(HashMap::new())),
            max_rps,
        }
    }

    pub async fn check(&self, ip: IpAddr) -> bool {
        let mut map = self.records.lock().await;
        let now = Instant::now();
        let entry = map.entry(ip).or_insert((0, now));
        if now.duration_since(entry.1) >= Duration::from_secs(1) {
            *entry = (1, now);
            true
        } else if entry.0 < self.max_rps {
            entry.0 += 1;
            true
        } else {
            false
        }
    }
}

pub async fn auth_middleware(
    req: Request,
    next: Next,
) -> Result<Response, (StatusCode, Json<serde_json::Value>)> {
    let auth_token = std::env::var("SPAAS_AUTH_TOKEN").unwrap_or_default();
    if auth_token.trim().is_empty() {
        return Ok(next.run(req).await);
    }

    let path = req.uri().path();

    // Exempt paths:
    // 1. Health checks & metrics
    // 2. Device pairing
    // 3. Node worker communications (authenticated via Ed25519 signatures)
    // 4. Downloads & APKs
    // 5. Web console static assets
    let is_exempt = path == "/health"
        || path == "/api/v1/system/health"
        || path == "/metrics"
        || path == "/api/v1/devices/pair"
        || path == "/api/v1/devices/pairing-token"
        || path.starts_with("/api/v1/nodes")
        || path.starts_with("/downloads")
        || path.starts_with("/api/v1/downloads")
        || path == "/app-debug.apk"
        || path == "/"
        || path == "/index.html"
        || path.starts_with("/assets")
        || path == "/vite.svg"
        || path == "/favicon.ico";

    if is_exempt {
        return Ok(next.run(req).await);
    }

    let auth_header = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|val| val.to_str().ok());

    let authorized = match auth_header {
        Some(h) if h.starts_with("Bearer ") => {
            let token = h[7..].trim();
            token == auth_token.trim()
        }
        _ => false,
    };

    if authorized {
        Ok(next.run(req).await)
    } else {
        Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "error": "UNAUTHORIZED",
                "message": "Missing or invalid Bearer authentication token in Authorization header"
            })),
        ))
    }
}

pub async fn rate_limit_middleware(
    req: Request,
    next: Next,
) -> Result<Response, (StatusCode, Json<serde_json::Value>)> {
    let max_rps = std::env::var("SPAAS_RATE_LIMIT_RPS")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(100);

    if max_rps == 0 {
        return Ok(next.run(req).await);
    }

    let ip: IpAddr = req
        .headers()
        .get("x-forwarded-for")
        .and_then(|hv| hv.to_str().ok())
        .and_then(|s| s.split(',').next())
        .and_then(|s| s.trim().parse().ok())
        .or_else(|| {
            req.headers()
                .get("x-real-ip")
                .and_then(|hv| hv.to_str().ok())
                .and_then(|s| s.trim().parse().ok())
        })
        .unwrap_or(IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)));

    static RATE_LIMITER: std::sync::OnceLock<RateLimiterState> = std::sync::OnceLock::new();
    let limiter = RATE_LIMITER.get_or_init(|| RateLimiterState::new(max_rps));

    if limiter.check(ip).await {
        Ok(next.run(req).await)
    } else {
        Err((
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({
                "error": "RATE_LIMITED",
                "message": "Request rate limit exceeded. Please throttle requests."
            })),
        ))
    }
}

pub fn build_router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        // Node Management, Qualification & Operational Controls
        .route("/api/v1/nodes/register", post(register_node))
        .route("/api/v1/nodes/heartbeat", post(heartbeat))
        .route("/api/v1/nodes/:node_id/poll", get(poll_job))
        .route(
            "/api/v1/nodes/:node_id/qualification",
            post(qualify_node).get(get_node_qualification),
        )
        .route(
            "/api/v1/nodes/:node_id/qualification/run",
            post(run_node_qualification),
        )
        .route(
            "/api/v1/nodes/:node_id/dispatch-challenge",
            post(dispatch_challenge_workload),
        )
        .route("/api/v1/nodes/:node_id/revoke", post(revoke_node))
        .route("/api/v1/nodes/:node_id/rename", post(rename_node))
        .route("/api/v1/nodes/:node_id/policy", post(update_node_policy))
        .route("/api/v1/nodes/:node_id/state", post(set_node_state))
        .route("/api/v1/nodes/:node_id", get(get_node).delete(remove_node))
        .route("/api/v1/nodes/results", post(submit_result))
        .route("/api/v1/nodes", get(list_nodes))
        // Device Pairing & Demo
        .route("/api/v1/devices/pairing-token", post(create_pairing_token))
        .route("/api/v1/devices/pair", post(pair_device))
        .route("/api/v1/demo/start-cluster", post(start_demo_cluster))
        .route(
            "/api/v1/demo/purge-simulated-nodes",
            post(purge_simulated_nodes),
        )
        // Job Management & Leases
        .route("/api/v1/jobs", post(submit_job).get(list_jobs))
        .route("/api/v1/jobs/:job_id", get(get_job))
        .route(
            "/api/v1/jobs/:job_id/scheduler-decision",
            get(get_job_scheduler_decision),
        )
        .route("/api/v1/jobs/:job_id/lease/renew", post(renew_job_lease))
        .route("/api/v1/jobs/:job_id/cancel", post(cancel_job))
        // System Observability, Live Events & Ledger
        .route("/health", get(get_health))
        .route("/api/v1/system/health", get(get_health))
        .route("/api/v1/system/network", get(get_system_network))
        .route("/api/v1/system/diagnostics", get(get_system_diagnostics))
        .route("/api/v1/events", get(get_events))
        .route("/api/v1/metering", get(get_metering))
        .route(
            "/api/v1/metering/consumer/:pubkey",
            get(get_consumer_balance),
        )
        .route("/api/v1/audit", get(get_audit_log))
        .route("/metrics", get(get_metrics))
        // Challenge & Real Verification
        .route(
            "/api/v1/workloads/challenge",
            post(create_challenge_workload),
        )
        // APK Artifact Downloads & Delivery
        .route("/app-debug.apk", get(download_apk))
        .route("/downloads/spaas-android-node.apk", get(download_apk))
        .route("/downloads/SPaaS-Node-v0.1.0.apk", get(download_apk))
        .route("/downloads/SPaaS-Node-latest.apk", get(download_apk))
        .route("/api/v1/downloads/apk-info", get(get_apk_info))
        .nest_service("/downloads", ServeDir::new("dist/bin"))
        .fallback_service(ServeDir::new("apps/web-console/dist"))
        .layer(from_fn(auth_middleware))
        .layer(from_fn(rate_limit_middleware))
        .layer(cors)
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tempfile::tempdir;
    use tower::ServiceExt;

    static TEST_ENV_MUTEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[tokio::test]
    async fn test_auth_middleware_exempt_routes() {
        let _lock = TEST_ENV_MUTEX.lock().await;
        std::env::set_var("SPAAS_AUTH_TOKEN", "secret-test-token-123");
        let dir = tempdir().unwrap();
        let state = AppState::new(dir.path());
        let app = build_router(state);

        // Exempt /health should succeed with 200 without auth header
        let req = Request::builder()
            .uri("/health")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        std::env::remove_var("SPAAS_AUTH_TOKEN");
    }

    #[tokio::test]
    async fn test_auth_middleware_blocks_protected_routes() {
        let _lock = TEST_ENV_MUTEX.lock().await;
        std::env::set_var("SPAAS_AUTH_TOKEN", "secret-test-token-123");
        let dir = tempdir().unwrap();
        let state = AppState::new(dir.path());
        let app = build_router(state);

        // Protected /api/v1/jobs should fail with 401 Unauthorized without auth header
        let req = Request::builder()
            .uri("/api/v1/jobs")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        std::env::remove_var("SPAAS_AUTH_TOKEN");
    }

    #[tokio::test]
    async fn test_auth_middleware_allows_with_valid_token() {
        let _lock = TEST_ENV_MUTEX.lock().await;
        std::env::set_var("SPAAS_AUTH_TOKEN", "secret-test-token-123");
        let dir = tempdir().unwrap();
        let state = AppState::new(dir.path());
        let app = build_router(state);

        // Protected /api/v1/jobs with valid bearer token should succeed
        let req = Request::builder()
            .uri("/api/v1/jobs")
            .header(header::AUTHORIZATION, "Bearer secret-test-token-123")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        std::env::remove_var("SPAAS_AUTH_TOKEN");
    }

    #[tokio::test]
    async fn test_rate_limiter_state() {
        let limiter = RateLimiterState::new(3);
        let ip = "127.0.0.1".parse().unwrap();

        assert!(limiter.check(ip).await);
        assert!(limiter.check(ip).await);
        assert!(limiter.check(ip).await);
        // 4th request exceeds max_rps of 3
        assert!(!limiter.check(ip).await);
    }
}
