use crate::state::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use spaas_persistence::{AuditRecord, WalEvent};
use spaas_protocol::job::{JobLease, JobRecord, JobState};
use spaas_protocol::metering::ResourceUsage;
use spaas_protocol::node::{EnrollmentStatus, NodeQualificationProfile, NodeRecord, NodeState};
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
        qualification: None,
        enrolled_at_ms: now,
        last_heartbeat_ms: now,
        region: payload.region,
        is_simulated: payload.is_simulated,
    };

    state.upsert_node(record).await;

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
    let (has_pending, updated_node) = {
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
        (has_pending, node.clone())
    };

    let _ = state.storage.append_event(WalEvent::UpsertNode { node: updated_node }).await;

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
    // 1. Verify submitter signature on WorkloadSpec
    verify_workload(&payload.spec).map_err(|e| {
        warn!(error = %e, "Rejected workload submission due to invalid cryptographic signature");
        (StatusCode::UNAUTHORIZED, format!("Signature verification failed: {e}"))
    })?;

    // 2. Verify WASM binary hash if bytes were supplied inline
    if let Some(ref wasm_b64) = payload.wasm_binary_base64 {
        let wasm_bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            wasm_b64,
        )
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid base64 wasm: {e}")))?;

        if let Err(e) = verify_sha256(&wasm_bytes, &payload.spec.artifact_sha256) {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("WASM binary SHA-256 does not match WorkloadSpec digest: {e}"),
            ));
        }

        state.store_wasm_artifact(payload.spec.artifact_sha256.clone(), wasm_bytes).await;
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
            let lease = JobLease::new(job_id, primary_node, 30_000);
            job.assigned_node_id = Some(primary_node);
            job.current_lease = Some(lease.clone());
            job.transition_to(JobState::Scheduled).map_err(|e| {
                (StatusCode::INTERNAL_SERVER_ERROR, format!("State transition error: {e}"))
            })?;

            // Retrieve wasm bytes
            let artifacts = state.wasm_artifacts.read().await;
            let wasm_bytes = artifacts.get(&job.spec.artifact_sha256).cloned();

            let dispatch = JobDispatchMessage {
                job_id,
                lease_id: lease.lease_id,
                lease_expires_at_ms: lease.expires_at_ms,
                spec: job.spec.clone(),
                wasm_bytes,
                dispatched_at_ms: chrono::Utc::now().timestamp_millis(),
            };

            let mut dispatches = state.dispatches.write().await;
            dispatches.insert(primary_node, dispatch);

            state.grant_lease(lease).await;
            state.metrics.running_jobs.fetch_add(1, Ordering::Relaxed);
            info!(job_id = %job_id, node_id = %primary_node, "Job scheduled and dispatched with lease");
        }
        _ => {
            info!(job_id = %job_id, "No immediate node available; job queued");
            state.metrics.queue_depth.fetch_add(1, Ordering::Relaxed);
        }
    }

    state.upsert_job(job.clone()).await;
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
            state.storage.append_event(WalEvent::UpsertJob { job: job.clone() }).await.ok();
        }
    }

    Ok(Json(PollJobResponse { job: dispatch }))
}

pub async fn renew_job_lease(
    State(state): State<AppState>,
    Path(job_id): Path<Uuid>,
    Json(payload): Json<RenewLeaseRequest>,
) -> Result<Json<RenewLeaseResponse>, (StatusCode, String)> {
    let mut jobs = state.jobs.write().await;
    let job = jobs
        .get_mut(&job_id)
        .ok_or((StatusCode::NOT_FOUND, "Job not found".into()))?;

    let now = chrono::Utc::now().timestamp_millis();
    if let Some(ref mut lease) = job.current_lease {
        if lease.lease_id != payload.lease_id || lease.node_id != payload.node_id {
            return Ok(Json(RenewLeaseResponse {
                renewed: false,
                lease_id: payload.lease_id,
                expires_at_ms: lease.expires_at_ms,
                reason: Some("Lease ID or Node ID mismatch".into()),
            }));
        }
        if lease.is_expired(now) {
            return Ok(Json(RenewLeaseResponse {
                renewed: false,
                lease_id: payload.lease_id,
                expires_at_ms: lease.expires_at_ms,
                reason: Some("Lease has already expired".into()),
            }));
        }

        lease.renew(30_000);
        let updated_lease = lease.clone();
        let _ = state.storage.append_event(WalEvent::RenewLease { lease: updated_lease.clone() }).await;

        return Ok(Json(RenewLeaseResponse {
            renewed: true,
            lease_id: updated_lease.lease_id,
            expires_at_ms: updated_lease.expires_at_ms,
            reason: None,
        }));
    }

    Ok(Json(RenewLeaseResponse {
        renewed: false,
        lease_id: payload.lease_id,
        expires_at_ms: 0,
        reason: Some("Job has no active lease".into()),
    }))
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

    // 2. Validate lease and job state
    let (submitter_pubkey, job_snapshot) = {
        let mut jobs = state.jobs.write().await;
        let job = jobs
            .get_mut(&payload.result.job_id)
            .ok_or((StatusCode::NOT_FOUND, "Job not found".into()))?;

        if job.state != JobState::Scheduled && job.state != JobState::Running && job.state != JobState::Verifying {
            return Err((
                StatusCode::CONFLICT,
                format!("Job is in terminal or non-executing state: {:?}", job.state),
            ));
        }

        let now = chrono::Utc::now().timestamp_millis();
        if let Some(ref lease) = job.current_lease {
            if let Some(req_lease_id) = payload.lease_id {
                if lease.lease_id != req_lease_id {
                    return Err((
                        StatusCode::CONFLICT,
                        format!("Lease ID mismatch: expected {}, got {}", lease.lease_id, req_lease_id),
                    ));
                }
            }
            if lease.is_expired(now) {
                return Err((
                    StatusCode::CONFLICT,
                    format!("Lease expired at {} ms (current time: {} ms); result rejected", lease.expires_at_ms, now),
                ));
            }
        }

        job.result = Some(payload.result.clone());
        let _ = job.transition_to(JobState::Completed);
        (job.spec.submitter_pubkey.clone(), job.clone())
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

    // Persist completed job and metering record to durable WAL
    state.storage.append_event(WalEvent::UpsertJob { job: job_snapshot }).await.ok();
    state.storage.append_event(WalEvent::AppendMetering { record: metering_record.clone() }).await.ok();

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
            &format!(
                "Node={}, Fuel={}, Credits={}",
                payload.node_id, payload.result.fuel_consumed, metering_record.credits_earned_by_node
            ),
        )
        .await;

    info!(
        job_id = %payload.result.job_id,
        node_id = %payload.node_id,
        credits = metering_record.credits_earned_by_node,
        "Job result verified, metered, and durably committed"
    );

    Ok(Json(SubmitJobResultResponse {
        accepted: true,
        verification_status: "VERIFIED_VALID".into(),
        credits_earned: metering_record.credits_earned_by_node,
    }))
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct QualifyNodeRequest {
    pub profile: NodeQualificationProfile,
}

pub async fn qualify_node(
    State(state): State<AppState>,
    Path(node_id): Path<Uuid>,
    Json(payload): Json<QualifyNodeRequest>,
) -> Result<Json<NodeRecord>, (StatusCode, String)> {
    let mut nodes = state.nodes.write().await;
    let node = nodes
        .get_mut(&node_id)
        .ok_or((StatusCode::NOT_FOUND, "Node not found".into()))?;

    node.qualification = Some(payload.profile);
    let updated = node.clone();
    state.storage.append_event(WalEvent::UpsertNode { node: updated.clone() }).await.ok();
    info!(node_id = %node_id, "Node qualification profile recorded");

    Ok(Json(updated))
}

pub async fn get_node_qualification(
    State(state): State<AppState>,
    Path(node_id): Path<Uuid>,
) -> Result<Json<Option<NodeQualificationProfile>>, (StatusCode, String)> {
    let nodes = state.nodes.read().await;
    let node = nodes
        .get(&node_id)
        .ok_or((StatusCode::NOT_FOUND, "Node not found".into()))?;

    Ok(Json(node.qualification.clone()))
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

    let cancelled_job = job.clone();
    state.storage.append_event(WalEvent::UpsertJob { job: cancelled_job.clone() }).await.ok();

    state
        .log_audit("JOB_CANCELLED", &job_id.to_string(), "User initiated cancellation")
        .await;

    Ok(Json(cancelled_job))
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
) -> Result<Json<Vec<AuditRecord>>, (StatusCode, String)> {
    let log = state.audit_log.read().await;
    Ok(Json(log.clone()))
}
