use crate::handlers::*;
use crate::state::AppState;
use axum::{
    routing::{get, post},
    Router,
};
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;

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
        .layer(cors)
        .with_state(state)
}
