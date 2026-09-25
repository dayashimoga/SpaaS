use crate::handlers::*;
use crate::state::AppState;
use axum::{
    routing::{get, post},
    Router,
};
use tower_http::cors::{Any, CorsLayer};

pub fn build_router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        // Node Management
        .route("/api/v1/nodes/register", post(register_node))
        .route("/api/v1/nodes/heartbeat", post(heartbeat))
        .route("/api/v1/nodes/:node_id/poll", get(poll_job))
        .route("/api/v1/nodes/results", post(submit_result))
        .route("/api/v1/nodes", get(list_nodes))
        // Job Management
        .route("/api/v1/jobs", post(submit_job).get(list_jobs))
        .route("/api/v1/jobs/:job_id", get(get_job))
        .route("/api/v1/jobs/:job_id/cancel", post(cancel_job))
        // System Observability & Ledger
        .route("/api/v1/system/health", get(get_health))
        .route("/api/v1/metering", get(get_metering))
        .route("/api/v1/audit", get(get_audit_log))
        .route("/metrics", get(get_metrics))
        .layer(cors)
        .with_state(state)
}
