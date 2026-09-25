use crate::state::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use spaas_protocol::job::{JobRecord, JobState};
use spaas_protocol::metering::ResourceUsage;
use spaas_protocol::node::{EnrollmentStatus, NodeRecord, NodeState};
use spaas_protocol::rpc::*;
use spaas_security::hash::verify_sha256;
use spaas_security::signing::verify_workload;
use spaas_security::token::{AuthRole, AuthToken};
use std::sync::atomic::Ordering;
use tracing::{info, warn};
use uuid::Uuid;

pub async fn register_node(
    State(state): State<AppState>,
    Json(payload): Json<RegisterNodeRequest>,
) -> Result<Json<RegisterNodeResponse>, (StatusCode, String)> {
    let node_id = Uuid::new_v4();
    let now = chrono::Utc::now().timestamp_millis();

    let (_token, token_str) = AuthToken::issue(
        &state.server_keypair,
        node_id.to_string(),
        AuthRole::WorkerNode,
        86400 * 1000,
    );

    let record = NodeRecord {
        node_id,
        public_key: payload.public_key.clone(),
        device_type: payload.device_type,
        enrollment: EnrollmentStatus::Enrolled,
        state: NodeState::Idle,
        capabilities: payload.capabilities,
        telemetry: payload.initial_telemetry,
        policy: payload.initial_policy,
        enrolled_at_ms: now,
        last_heartbeat_ms: now,
        region: payload.region,
        is_simulated: payload.is_simulated,
    };

    {
        let mut nodes = state.nodes.write().await;
        nodes.insert(node_id, record);
    }

    state.metrics.active_nodes.fetch_add(1, Ordering::Relaxed);
    state.metrics.idle_nodes.fetch_add(1, Ordering::Relaxed);
    state
        .log_audit("NODE_REGISTERED", &node_id.to_string(), &payload.public_key)
        .await;

    info!(node_id = %node_id, is_simulated = payload.is_simulated, "Node successfully registered");

    Ok(Json(RegisterNodeResponse {
        node_id,
        auth_token: token_str,
        control_plane_pubkey: state.server_keypair.public_key_hex(),
        heartbeat_interval_secs: 15,
    }))
}

pub async fn heartbeat(
    State(state): State<AppState>,
    Json(payload): Json<HeartbeatRequest>,
) -> Result<Json<HeartbeatResponse>, (StatusCode, String)> {
    let mut nodes = state.nodes.write().await;
    let node = nodes
        .get_mut(&payload.node_id)
        .ok_or((StatusCode::NOT_FOUND, "Node not found".into()))?;

    let now = chrono::Utc::now().timestamp_millis();
    node.last_heartbeat_ms = now;
    node.telemetry = payload.telemetry;
    node.policy = payload.policy;

    if node.state == NodeState::Offline {
        node.state = NodeState::Idle;
        state.metrics.offline_nodes.fetch_sub(1, Ordering::Relaxed);
        state.metrics.idle_nodes.fetch_add(1, Ordering::Relaxed);
    }

    let dispatches = state.dispatches.read().await;
    let has_pending = dispatches.contains_key(&payload.node_id);

    Ok(Json(HeartbeatResponse {
        acknowledged: true,
        pending_jobs_count: if has_pending { 1 } else { 0 },
        command: None,
    }))
}

pub async fn submit_job(
    State(state): State<AppState>,
    Json(payload): Json<SubmitJobRequest>,
) -> Result<Json<SubmitJobResponse>, (StatusCode, String)> {
    // 1. Verify submitter cryptographic signature on WorkloadSpec
    verify_workload(&payload.spec).map_err(|e| {
        warn!(error = %e, "Rejected workload with invalid cryptographic signature");
        (StatusCode::BAD_REQUEST, format!("Invalid workload signature: {e}"))
    })?;

    // 2. Cache WASM bytecode if provided
    if let Some(b64) = &payload.wasm_binary_base64 {
        let bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            b64.trim(),
        )
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Base64 decode error: {e}")))?;

        verify_sha256(&bytes, &payload.spec.artifact_sha256).map_err(|e| {
            (StatusCode::BAD_REQUEST, format!("WASM hash verification failed: {e}"))
        })?;

        let mut artifacts = state.wasm_artifacts.write().await;
        artifacts.insert(payload.spec.artifact_sha256.clone(), bytes);
    }

    let mut job = JobRecord::new(payload.spec.clone());
    let job_id = job.job_id;

    // 3. Attempt immediate scheduling
    let eligible_nodes: Vec<NodeRecord> = {
        let nodes = state.nodes.read().await;
        nodes.values().cloned().collect()
    };

    match state.scheduler.schedule_workload(&job.spec, &eligible_nodes) {
        Ok(selected_nodes) if !selected_nodes.is_empty() => {
            let primary_node = selected_nodes[0];
            job.assigned_node_id = Some(primary_node);
            job.transition_to(JobState::Scheduled).map_err(|e| {
                (StatusCode::INTERNAL_SERVER_ERROR, format!("State transition error: {e}"))
            })?;

            // Retrieve wasm bytes
            let artifacts = state.wasm_artifacts.read().await;
            let wasm_bytes = artifacts.get(&job.spec.artifact_sha256).cloned();

            let dispatch = JobDispatchMessage {
                job_id,
                spec: job.spec.clone(),
                wasm_bytes,
                dispatched_at_ms: chrono::Utc::now().timestamp_millis(),
            };

            let mut dispatches = state.dispatches.write().await;
            dispatches.insert(primary_node, dispatch);

            state.metrics.running_jobs.fetch_add(1, Ordering::Relaxed);
            info!(job_id = %job_id, node_id = %primary_node, "Job scheduled and dispatched to node");
        }
        _ => {
            info!(job_id = %job_id, "No immediate node available; job queued");
            state.metrics.queue_depth.fetch_add(1, Ordering::Relaxed);
        }
    }

    {
        let mut jobs = state.jobs.write().await;
        jobs.insert(job_id, job.clone());
    }

    state.metrics.api_requests_total.fetch_add(1, Ordering::Relaxed);
    state
        .log_audit("JOB_SUBMITTED", &job_id.to_string(), &payload.spec.name)
        .await;

    Ok(Json(SubmitJobResponse {
        job_id,
        state: job.state,
        queued_at_ms: job.created_at_ms,
        estimated_wait_ms: 1000,
    }))
}

pub async fn poll_job(
    State(state): State<AppState>,
    Path(node_id): Path<Uuid>,
) -> Result<Json<PollJobResponse>, (StatusCode, String)> {
    let mut dispatches = state.dispatches.write().await;
    let dispatch = dispatches.remove(&node_id);

    if let Some(ref d) = dispatch {
        let mut jobs = state.jobs.write().await;
        if let Some(job) = jobs.get_mut(&d.job_id) {
            let _ = job.transition_to(JobState::Running);
        }
    }

    Ok(Json(PollJobResponse { job: dispatch }))
}

pub async fn submit_result(
    State(state): State<AppState>,
    Json(payload): Json<SubmitJobResultRequest>,
) -> Result<Json<SubmitJobResultResponse>, (StatusCode, String)> {
    let node_pubkey = {
        let nodes = state.nodes.read().await;
        let node = nodes
            .get(&payload.node_id)
            .ok_or((StatusCode::NOT_FOUND, "Node not found".into()))?;
        node.public_key.clone()
    };

    // 1. Verify result cryptography
    state
        .verification
        .verify_single_result(&payload.result, &node_pubkey)
        .map_err(|e| {
            warn!(error = %e, "Submitted result failed cryptographic verification");
            (StatusCode::BAD_REQUEST, format!("Verification error: {e}"))
        })?;

    // 2. Update job record
    let submitter_pubkey = {
        let mut jobs = state.jobs.write().await;
        let job = jobs
            .get_mut(&payload.result.job_id)
            .ok_or((StatusCode::NOT_FOUND, "Job not found".into()))?;

        job.result = Some(payload.result.clone());
        let _ = job.transition_to(JobState::Completed);
        job.spec.submitter_pubkey.clone()
    };

    // 3. Metering & Credit transfer
    let usage = ResourceUsage {
        fuel_consumed: payload.result.fuel_consumed,
        wall_time_ms: payload.result.wall_time_ms,
        memory_peak_bytes: payload.result.peak_memory_bytes,
        network_ingress_bytes: 4096,
        network_egress_bytes: payload.result.stdout.len() as u64 + payload.result.stderr.len() as u64,
        storage_bytes: 0,
    };

    let metering_record = {
        let mut ledger = state.ledger.write().await;
        ledger
            .record_job_execution(
                payload.result.job_id,
                payload.node_id,
                &payload.result.result_digest,
                &node_pubkey,
                &submitter_pubkey,
                usage,
                true,
            )
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Metering error: {e}")))?
    };

    state.metrics.completed_jobs.fetch_add(1, Ordering::Relaxed);
    state.metrics.running_jobs.fetch_sub(1, Ordering::Relaxed);
    state.metrics.credits_transferred_total.fetch_add(
        metering_record.credits_earned_by_node,
        Ordering::Relaxed,
    );

    state
        .log_audit(
            "JOB_COMPLETED",
            &payload.result.job_id.to_string(),
            &format!("Credits: {}", metering_record.credits_earned_by_node),
        )
        .await;

    Ok(Json(SubmitJobResultResponse {
        accepted: true,
        verification_status: "VERIFIED_VALID".into(),
        credits_earned: metering_record.credits_earned_by_node,
    }))
}

pub async fn get_job(
    State(state): State<AppState>,
    Path(job_id): Path<Uuid>,
) -> Result<Json<JobRecord>, (StatusCode, String)> {
    let jobs = state.jobs.read().await;
    let job = jobs
        .get(&job_id)
        .ok_or((StatusCode::NOT_FOUND, "Job not found".into()))?;
    Ok(Json(job.clone()))
}

pub async fn list_jobs(
    State(state): State<AppState>,
) -> Result<Json<ListJobsResponse>, (StatusCode, String)> {
    let jobs = state.jobs.read().await;
    let list: Vec<JobRecord> = jobs.values().cloned().collect();
    let total = list.len();
    Ok(Json(ListJobsResponse { jobs: list, total }))
}

pub async fn cancel_job(
    State(state): State<AppState>,
    Path(job_id): Path<Uuid>,
) -> Result<Json<JobRecord>, (StatusCode, String)> {
    let mut jobs = state.jobs.write().await;
    let job = jobs
        .get_mut(&job_id)
        .ok_or((StatusCode::NOT_FOUND, "Job not found".into()))?;

    job.transition_to(JobState::Cancelled)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Cannot cancel job: {e}")))?;

    state
        .log_audit("JOB_CANCELLED", &job_id.to_string(), "User initiated cancellation")
        .await;

    Ok(Json(job.clone()))
}

pub async fn list_nodes(
    State(state): State<AppState>,
) -> Result<Json<ListNodesResponse>, (StatusCode, String)> {
    let nodes = state.nodes.read().await;
    let list: Vec<NodeRecord> = nodes.values().cloned().collect();
    let total = list.len();
    Ok(Json(ListNodesResponse { nodes: list, total }))
}

pub async fn get_health(
    State(state): State<AppState>,
) -> Result<Json<SystemHealthResponse>, (StatusCode, String)> {
    let nodes = state.nodes.read().await;
    let jobs = state.jobs.read().await;

    let active = nodes.values().filter(|n| n.state == NodeState::Active).count();
    let idle = nodes.values().filter(|n| n.state == NodeState::Idle).count();
    let paused = nodes.values().filter(|n| n.state == NodeState::Paused).count();
    let offline = nodes.values().filter(|n| n.state == NodeState::Offline).count();

    let queued = jobs.values().filter(|j| j.state == JobState::Queued).count();
    let running = jobs.values().filter(|j| j.state == JobState::Running).count();

    let uptime = (chrono::Utc::now().timestamp_millis() - state.started_at_ms) / 1000;

    Ok(Json(SystemHealthResponse {
        status: "HEALTHY".into(),
        active_nodes: active,
        idle_nodes: idle,
        paused_nodes: paused,
        offline_nodes: offline,
        queue_depth: queued,
        running_jobs: running,
        completed_jobs: state.metrics.completed_jobs.load(Ordering::Relaxed),
        failed_jobs: state.metrics.failed_jobs.load(Ordering::Relaxed),
        average_scheduling_latency_ms: 1.45,
        uptime_secs: uptime as u64,
    }))
}

pub async fn get_metrics(State(state): State<AppState>) -> impl IntoResponse {
    Response::builder()
        .header("content-type", "text/plain; version=0.0.4")
        .body(state.metrics.render_prometheus())
        .unwrap()
}

pub async fn get_metering(
    State(state): State<AppState>,
) -> Result<Json<Vec<spaas_protocol::metering::MeteringRecord>>, (StatusCode, String)> {
    let ledger = state.ledger.read().await;
    Ok(Json(ledger.all_records()))
}

pub async fn get_audit_log(
    State(state): State<AppState>,
) -> Result<Json<Vec<crate::state::AuditRecord>>, (StatusCode, String)> {
    let log = state.audit_log.read().await;
    Ok(Json(log.clone()))
}
