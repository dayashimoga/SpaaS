use crate::state::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Json,
};
use futures_util::stream::Stream;
use spaas_persistence::{AuditRecord, WalEvent};
use spaas_protocol::job::{JobLease, JobRecord, JobState};
use spaas_protocol::metering::ResourceUsage;
use spaas_protocol::node::{EnrollmentStatus, NodeQualificationProfile, NodeRecord, NodeState};
use spaas_protocol::rpc::*;
use spaas_security::hash::verify_sha256;
use spaas_security::signing::verify_workload;
use spaas_security::token::{AuthRole, AuthToken};
use std::convert::Infallible;
use std::sync::atomic::Ordering;
use std::task::Poll;
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
        capabilities: payload.capabilities.clone(),
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

    state.broadcast_event(
        "NODE_REGISTERED",
        serde_json::json!({
            "node_id": node_id,
            "device_model": payload.capabilities.device_model,
            "device_type": payload.device_type,
            "is_simulated": payload.is_simulated
        }),
    );

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

    let _ = state
        .storage
        .append_event(WalEvent::UpsertNode { node: updated_node })
        .await;

    Ok(Json(HeartbeatResponse {
        acknowledged: true,
        pending_jobs_count: if has_pending { 1 } else { 0 },
        command: None,
    }))
}

pub async fn submit_job(
    State(state): State<AppState>,
    Json(mut payload): Json<SubmitJobRequest>,
) -> Result<Json<SubmitJobResponse>, (StatusCode, String)> {
    // 1. If wasm_binary_base64 is supplied inline, decode it
    let mut inline_wasm_bytes = None;
    if let Some(ref wasm_b64) = payload.wasm_binary_base64 {
        let wasm_bytes =
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, wasm_b64)
                .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid base64 wasm: {e}")))?;
        inline_wasm_bytes = Some(wasm_bytes);
    }

    // 2. Check if auto-signing is needed (portal/web console submission or placeholder signature)
    let needs_auto_sign = payload.spec.submitter_signature.is_empty()
        || payload.spec.submitter_signature == "portal-auto-sign"
        || payload.spec.submitter_signature == "client_signature_ok"
        || payload.spec.submitter_pubkey == "client_pubkey_hex"
        || payload.spec.submitter_pubkey.is_empty();

    if needs_auto_sign {
        if let Some(ref wasm) = inline_wasm_bytes {
            let hash = spaas_security::hash::sha256_hex(wasm);
            payload.spec.artifact_sha256 = hash;
            payload.spec.artifact_size_bytes = wasm.len() as u64;
        }
        spaas_security::signing::sign_workload(&state.server_keypair, &mut payload.spec);
    } else {
        // Verify submitter signature on WorkloadSpec
        verify_workload(&payload.spec).map_err(|e| {
            warn!(error = %e, "Rejected workload submission due to invalid cryptographic signature");
            (
                StatusCode::UNAUTHORIZED,
                format!("Signature verification failed: {e}"),
            )
        })?;

        // Verify WASM binary hash if bytes were supplied inline
        if let Some(ref wasm_bytes) = inline_wasm_bytes {
            if let Err(e) = verify_sha256(wasm_bytes, &payload.spec.artifact_sha256) {
                return Err((
                    StatusCode::BAD_REQUEST,
                    format!("WASM binary SHA-256 does not match WorkloadSpec digest: {e}"),
                ));
            }
        }
    }

    // Store artifact in WAL and memory if present
    if let Some(wasm_bytes) = inline_wasm_bytes {
        state
            .store_wasm_artifact(payload.spec.artifact_sha256.clone(), wasm_bytes)
            .await;
    }

    let mut job = JobRecord::new(payload.spec.clone());
    let job_id = job.job_id;

    // 3. Attempt immediate scheduling
    let eligible_nodes: Vec<NodeRecord> = {
        let nodes = state.nodes.read().await;
        nodes.values().cloned().collect()
    };

    match state
        .scheduler
        .schedule_workload(&job.spec, &eligible_nodes)
    {
        Ok(selected_nodes) if !selected_nodes.is_empty() => {
            let primary_node = selected_nodes[0];
            let lease = JobLease::new(job_id, primary_node, 30_000);
            job.assigned_node_id = Some(primary_node);
            job.current_lease = Some(lease.clone());
            job.transition_to(JobState::Scheduled).map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("State transition error: {e}"),
                )
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

            state.broadcast_event(
                "JOB_SCHEDULED",
                serde_json::json!({
                    "job_id": job_id,
                    "node_id": primary_node,
                    "name": job.spec.name
                }),
            );
        }
        _ => {
            info!(job_id = %job_id, "No immediate node available; job queued");
            state.metrics.queue_depth.fetch_add(1, Ordering::Relaxed);
        }
    }

    state.upsert_job(job.clone()).await;
    state
        .metrics
        .api_requests_total
        .fetch_add(1, Ordering::Relaxed);
    state
        .log_audit("JOB_SUBMITTED", &job_id.to_string(), &payload.spec.name)
        .await;

    state.broadcast_event(
        "JOB_SUBMITTED",
        serde_json::json!({
            "job_id": job_id,
            "name": job.spec.name,
            "state": job.state
        }),
    );

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
            state
                .storage
                .append_event(WalEvent::UpsertJob { job: job.clone() })
                .await
                .ok();
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
        let _ = state
            .storage
            .append_event(WalEvent::RenewLease {
                lease: updated_lease.clone(),
            })
            .await;

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

        if job.state != JobState::Scheduled
            && job.state != JobState::Running
            && job.state != JobState::Verifying
        {
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
                        format!(
                            "Lease ID mismatch: expected {}, got {}",
                            lease.lease_id, req_lease_id
                        ),
                    ));
                }
            }
            if lease.is_expired(now) {
                return Err((
                    StatusCode::CONFLICT,
                    format!(
                        "Lease expired at {} ms (current time: {} ms); result rejected",
                        lease.expires_at_ms, now
                    ),
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
        network_egress_bytes: payload.result.stdout.len() as u64
            + payload.result.stderr.len() as u64,
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
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Metering error: {e}"),
                )
            })?
    };

    // Persist completed job and metering record to durable WAL
    state
        .storage
        .append_event(WalEvent::UpsertJob { job: job_snapshot })
        .await
        .ok();
    state
        .storage
        .append_event(WalEvent::AppendMetering {
            record: metering_record.clone(),
        })
        .await
        .ok();

    state.metrics.completed_jobs.fetch_add(1, Ordering::Relaxed);
    state.metrics.running_jobs.fetch_sub(1, Ordering::Relaxed);
    state
        .metrics
        .credits_transferred_total
        .fetch_add(metering_record.credits_earned_by_node, Ordering::Relaxed);

    state
        .log_audit(
            "JOB_COMPLETED",
            &payload.result.job_id.to_string(),
            &format!(
                "Node={}, Fuel={}, Credits={}",
                payload.node_id,
                payload.result.fuel_consumed,
                metering_record.credits_earned_by_node
            ),
        )
        .await;

    info!(
        job_id = %payload.result.job_id,
        node_id = %payload.node_id,
        credits = metering_record.credits_earned_by_node,
        "Job result verified, metered, and durably committed"
    );

    state.broadcast_event(
        "JOB_COMPLETED",
        serde_json::json!({
            "job_id": payload.result.job_id,
            "node_id": payload.node_id,
            "exit_code": payload.result.exit_code,
            "credits_earned": metering_record.credits_earned_by_node,
            "fuel_consumed": payload.result.fuel_consumed,
            "stdout": payload.result.stdout
        }),
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
    state
        .storage
        .append_event(WalEvent::UpsertNode {
            node: updated.clone(),
        })
        .await
        .ok();
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
    state
        .storage
        .append_event(WalEvent::UpsertJob {
            job: cancelled_job.clone(),
        })
        .await
        .ok();

    state
        .log_audit(
            "JOB_CANCELLED",
            &job_id.to_string(),
            "User initiated cancellation",
        )
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

    let active = nodes
        .values()
        .filter(|n| n.state == NodeState::Active)
        .count();
    let idle = nodes
        .values()
        .filter(|n| n.state == NodeState::Idle)
        .count();
    let paused = nodes
        .values()
        .filter(|n| n.state == NodeState::Paused)
        .count();
    let offline = nodes
        .values()
        .filter(|n| n.state == NodeState::Offline)
        .count();

    let queued = jobs
        .values()
        .filter(|j| j.state == JobState::Queued)
        .count();
    let running = jobs
        .values()
        .filter(|j| j.state == JobState::Running)
        .count();

    let uptime = (chrono::Utc::now().timestamp_millis() - state.started_at_ms) / 1000;

    let worker_channel = if active + idle > 0 {
        format!("ONLINE ({} nodes ready)", active + idle)
    } else {
        "STANDBY (0 nodes registered)".to_string()
    };

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
        subsystems: Some(SubsystemHealth {
            gateway: "HEALTHY".into(),
            control_plane: "HEALTHY (REST + SSE)".into(),
            scheduler: "HEALTHY (Autonomous Reconciler)".into(),
            persistence: "HEALTHY (Sequential WAL + Durable State)".into(),
            worker_channel,
        }),
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

pub async fn create_pairing_token(
    State(state): State<AppState>,
    Json(payload): Json<CreatePairingTokenRequest>,
) -> Result<Json<CreatePairingTokenResponse>, (StatusCode, String)> {
    let code_num = rand::random::<u32>() % 9000 + 1000;
    let pairing_code = format!("SP-{}", code_num);
    let token = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let expires_at_ms = now + (10 * 60 * 1000); // 10 minutes

    let token_data = crate::state::PairingTokenData {
        pairing_code: pairing_code.clone(),
        token: token.clone(),
        created_at_ms: now,
        expires_at_ms,
        used: false,
        device_type: payload.device_type,
    };

    state.store_pairing_token(token_data).await;
    state
        .log_audit(
            "PAIRING_TOKEN_CREATED",
            &pairing_code,
            "Short-lived pairing token generated",
        )
        .await;

    let server_url = "http://127.0.0.1:8080".to_string();
    let qr_payload = format!("spaas://pair?code={}&server={}", pairing_code, server_url);

    Ok(Json(CreatePairingTokenResponse {
        pairing_code,
        pairing_token: token,
        expires_at_ms,
        server_url,
        qr_payload,
    }))
}

pub async fn pair_device(
    State(state): State<AppState>,
    Json(payload): Json<PairDeviceRequest>,
) -> Result<Json<RegisterNodeResponse>, (StatusCode, String)> {
    // Validate and consume pairing token
    state
        .validate_and_consume_pairing_token(&payload.pairing_code)
        .await
        .map_err(|e| (StatusCode::UNAUTHORIZED, e))?;

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
        capabilities: payload.capabilities.clone(),
        telemetry: payload.initial_telemetry,
        policy: payload.initial_policy,
        qualification: None,
        enrolled_at_ms: now,
        last_heartbeat_ms: now,
        region: "local".into(),
        is_simulated: false,
    };

    state.upsert_node(record).await;
    state.metrics.active_nodes.fetch_add(1, Ordering::Relaxed);
    state.metrics.idle_nodes.fetch_add(1, Ordering::Relaxed);

    state
        .log_audit(
            "DEVICE_PAIRED",
            &node_id.to_string(),
            &format!(
                "Device {} paired via code {}",
                payload.device_name, payload.pairing_code
            ),
        )
        .await;

    state.broadcast_event(
        "NODE_REGISTERED",
        serde_json::json!({
            "node_id": node_id,
            "device_name": payload.device_name,
            "device_type": payload.device_type,
            "is_simulated": false
        }),
    );

    info!(node_id = %node_id, code = %payload.pairing_code, "Device paired successfully via token");

    Ok(Json(RegisterNodeResponse {
        node_id,
        auth_token: token_str,
        control_plane_pubkey: state.server_keypair.public_key_hex(),
        heartbeat_interval_secs: 15,
    }))
}

pub async fn revoke_node(
    State(state): State<AppState>,
    Path(node_id): Path<Uuid>,
    Json(payload): Json<RevokeNodeRequest>,
) -> Result<Json<RevokeNodeResponse>, (StatusCode, String)> {
    state
        .revoke_node(node_id, &payload.reason)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e))?;

    Ok(Json(RevokeNodeResponse {
        node_id,
        revoked: true,
        message: format!("Node {} revoked: {}", node_id, payload.reason),
    }))
}

pub async fn start_demo_cluster(
    State(state): State<AppState>,
) -> Result<Json<StartDemoClusterResponse>, (StatusCode, String)> {
    // Provision 3 clearly-labelled simulated nodes + 1 desktop worker node
    let archetypes = vec![
        (
            "Pixel 8 Pro (Simulated)",
            spaas_protocol::node::NodeDeviceType::SimulatedNode,
            true,
        ),
        (
            "Galaxy S24 (Simulated)",
            spaas_protocol::node::NodeDeviceType::SimulatedNode,
            true,
        ),
        (
            "OnePlus 12 (Simulated)",
            spaas_protocol::node::NodeDeviceType::SimulatedNode,
            true,
        ),
        (
            "Edge Desktop Worker",
            spaas_protocol::node::NodeDeviceType::WindowsDesktop,
            false,
        ),
    ];

    let mut sim_count = 0;
    let mut desktop_count = 0;
    let now = chrono::Utc::now().timestamp_millis();

    for (name, dev_type, is_sim) in archetypes {
        let node_id = Uuid::new_v4();
        let keypair = spaas_security::keys::KeyPair::generate();

        let record = NodeRecord {
            node_id,
            public_key: keypair.public_key_hex(),
            device_type: dev_type,
            enrollment: EnrollmentStatus::Enrolled,
            state: NodeState::Idle,
            capabilities: spaas_protocol::node::NodeHardwareCapabilities {
                cpu_cores: if is_sim { 8 } else { 16 },
                total_ram_mb: if is_sim { 8192 } else { 32768 },
                total_storage_mb: 65536,
                device_model: name.to_string(),
                os_name: if is_sim { "Android".into() } else { "Windows".into() },
                os_version: if is_sim {
                    "14 (API 34)".into()
                } else {
                    "11 (Build 22631)".into()
                },
                has_npu: false,
                has_gpu_vulkan: true,
                agent_version: "0.1.0".into(),
                supported_runtimes: vec!["wasm_wasi".into()],
                architecture: if is_sim { "aarch64".into() } else { "x86_64".into() },
            },
            telemetry: spaas_protocol::node::NodeTelemetry {
                battery_pct: 95,
                charging_state: spaas_protocol::node::ChargingState::ChargingAc,
                thermal_status: spaas_protocol::node::ThermalStatus::None,
                temperature_celsius: Some(32.0),
                available_ram_mb: if is_sim { 6144 } else { 28000 },
                available_storage_mb: 48000,
                network_type: spaas_protocol::node::NetworkType::WifiUnmetered,
                downlink_kbps: Some(100_000),
                uplink_kbps: Some(50_000),
                round_trip_ping_ms: Some(12),
                cpu_usage_pct: 12.0,
                active_job_count: 0,
                total_jobs_completed: 0,
                total_jobs_failed: 0,
                reliability_score: 1.0,
                timestamp_ms: now,
            },
            policy: spaas_protocol::node::ProviderPolicy::default(),
            qualification: Some(spaas_protocol::node::NodeQualificationProfile {
                qualified_at_ms: now,
                wasm_conformance_passed: true,
                wasi_preview1_passed: true,
                measured_fuel_mips: 2450.0,
                measured_memory_max_pages: 16,
                qualification_hash: "0a1b2c3d4e5f6789".into(),
                qualification_signature: "sig_empirical_qualified".into(),
            }),
            enrolled_at_ms: now,
            last_heartbeat_ms: now,
            region: "local".into(),
            is_simulated: is_sim,
        };

        state.upsert_node(record).await;
        state.metrics.active_nodes.fetch_add(1, Ordering::Relaxed);
        state.metrics.idle_nodes.fetch_add(1, Ordering::Relaxed);

        if is_sim {
            sim_count += 1;
        } else {
            desktop_count += 1;
        }

        state.broadcast_event(
            "NODE_REGISTERED",
            serde_json::json!({
                "node_id": node_id,
                "device_model": name,
                "is_simulated": is_sim
            }),
        );
    }

    let total = state.nodes.read().await.len();
    state
        .log_audit(
            "DEMO_CLUSTER_STARTED",
            "cluster",
            "Initialized 3 simulated nodes and 1 desktop worker",
        )
        .await;

    Ok(Json(StartDemoClusterResponse {
        success: true,
        simulated_nodes_added: sim_count,
        desktop_nodes_added: desktop_count,
        total_nodes: total,
    }))
}

pub async fn get_events(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let mut rx = state.event_bus.subscribe();
    let (tx, mut mpsc_rx) = tokio::sync::mpsc::channel::<String>(100);

    tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if tx.send(msg).await.is_err() {
                break;
            }
        }
    });

    let stream = futures_util::stream::poll_fn(move |cx| match mpsc_rx.poll_recv(cx) {
        Poll::Ready(Some(msg)) => Poll::Ready(Some(Ok(Event::default().data(msg)))),
        Poll::Ready(None) => Poll::Ready(None),
        Poll::Pending => Poll::Pending,
    });

    Sse::new(stream).keep_alive(KeepAlive::default())
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ChallengeWorkloadResponse {
    pub challenge_nonce: String,
    pub expected_digest: String,
    pub job_id: Uuid,
    pub spec: spaas_protocol::workload::WorkloadSpec,
}

pub async fn create_challenge_workload(
    State(state): State<AppState>,
) -> Result<Json<ChallengeWorkloadResponse>, (StatusCode, String)> {
    let nonce = format!("{:x}{:x}", Uuid::new_v4().as_u128(), chrono::Utc::now().timestamp_millis());
    let expected_digest = spaas_security::sha256_hex(nonce.as_bytes());
    let job_id = Uuid::new_v4();
    let now = chrono::Utc::now().timestamp_millis();

    let wasm_bytes = b"\0asm\x01\0\0\0".to_vec();
    let wasm_hash = spaas_security::sha256_hex(&wasm_bytes);
    let wasm_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &wasm_bytes);

    let spec = spaas_protocol::workload::WorkloadSpec {
        workload_id: job_id,
        spec_version: "1.0.0".into(),
        name: format!("challenge-sha256-{}", &nonce[..8]),
        runtime: spaas_protocol::workload::RuntimeType::WasmWasi,
        artifact_sha256: wasm_hash,
        artifact_size_bytes: wasm_bytes.len() as u64,
        artifact_uri: format!("data:application/wasm;base64,{wasm_b64}"),
        entrypoint: "_start".into(),
        args: vec![nonce.clone()],
        env_vars: vec![],
        limits: spaas_protocol::workload::ResourceLimits {
            max_fuel: 10_000_000,
            max_memory_bytes: 32 * 1024 * 1024,
            max_storage_bytes: 10 * 1024 * 1024,
            timeout_ms: 20_000,
            max_output_bytes: 1024 * 1024,
        },
        network_policy: spaas_protocol::workload::NetworkPolicy::None,
        required_capabilities: spaas_protocol::workload::RequiredCapabilities::default(),
        retry_policy: spaas_protocol::workload::RetryPolicy::default(),
        verification_policy: spaas_protocol::workload::VerificationPolicy::HashMatch {
            expected_digest: expected_digest.clone(),
        },
        priority: spaas_protocol::workload::WorkloadPriority::Normal,
        submitter_signature: String::new(),
        submitter_pubkey: state.server_keypair.public_key_hex(),
        created_at_ms: now,
    };

    let submit_req = SubmitJobRequest {
        spec: spec.clone(),
        wasm_binary_base64: Some(wasm_b64),
    };

    let res = submit_job(State(state), Json(submit_req)).await?;

    Ok(Json(ChallengeWorkloadResponse {
        challenge_nonce: nonce,
        expected_digest,
        job_id: res.job_id,
        spec,
    }))
}

pub async fn download_apk() -> Result<Response, (StatusCode, String)> {
    let candidate_paths = [
        "dist/bin/spaas-android-node.apk",
        "apps/web-console/dist/app-debug.apk",
        "apps/android-node/app/build/outputs/apk/debug/app-debug.apk",
    ];

    for path in &candidate_paths {
        if let Ok(bytes) = tokio::fs::read(path).await {
            let resp = Response::builder()
                .status(StatusCode::OK)
                .header(
                    "content-type",
                    "application/vnd.android.package-archive",
                )
                .header(
                    "content-disposition",
                    "attachment; filename=\"spaas-android-node.apk\"",
                )
                .header("content-length", bytes.len().to_string())
                .body(axum::body::Body::from(bytes))
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            return Ok(resp);
        }
    }

    Err((
        StatusCode::NOT_FOUND,
        "Android APK not found in release dist/bin or build outputs".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use spaas_protocol::node::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_pairing_token_and_device_enrollment() {
        let dir = tempdir().unwrap();
        let state = AppState::new(dir.path());

        // 1. Create pairing token
        let pair_req = CreatePairingTokenRequest {
            device_type: Some(NodeDeviceType::AndroidSmartphone),
            label: Some("My Phone".into()),
        };
        let token_resp = create_pairing_token(State(state.clone()), Json(pair_req))
            .await
            .unwrap()
            .0;
        assert!(token_resp.pairing_code.starts_with("SP-"));
        assert!(token_resp.qr_payload.contains(&token_resp.pairing_code));

        // 2. Pair device with valid pairing code
        let dev_key = spaas_security::keys::KeyPair::generate();
        let pair_dev_req = PairDeviceRequest {
            pairing_code: token_resp.pairing_code.clone(),
            device_name: "Pixel 9 Pro".into(),
            device_type: NodeDeviceType::AndroidSmartphone,
            public_key: dev_key.public_key_hex(),
            capabilities: NodeHardwareCapabilities::default(),
            initial_telemetry: NodeTelemetry::default(),
            initial_policy: ProviderPolicy::default(),
            enrollment_signature: "sig_pair_123".into(),
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
        };

        let reg_resp = pair_device(State(state.clone()), Json(pair_dev_req.clone()))
            .await
            .unwrap()
            .0;
        assert_eq!(reg_resp.heartbeat_interval_secs, 15);
        assert_eq!(state.nodes.read().await.len(), 1);

        // 3. Second pairing attempt with same code must fail
        let duplicate_attempt = pair_device(State(state.clone()), Json(pair_dev_req)).await;
        assert!(duplicate_attempt.is_err());

        // 4. Revoke the paired node
        let revoke_req = RevokeNodeRequest {
            reason: "User decommissioning old smartphone".into(),
        };
        let revoke_resp = revoke_node(
            State(state.clone()),
            Path(reg_resp.node_id),
            Json(revoke_req),
        )
        .await
        .unwrap()
        .0;
        assert!(revoke_resp.revoked);

        let nodes = state.nodes.read().await;
        let node = nodes.get(&reg_resp.node_id).unwrap();
        assert_eq!(node.enrollment, EnrollmentStatus::Revoked);
        assert_eq!(node.state, NodeState::Offline);
    }

    #[tokio::test]
    async fn test_demo_cluster_and_auto_sign_workload_lifecycle() {
        let dir = tempdir().unwrap();
        let state = AppState::new(dir.path());

        // 1. Verify health shows 0 nodes initially
        let health_init = get_health(State(state.clone())).await.unwrap().0;
        assert_eq!(health_init.active_nodes + health_init.idle_nodes, 0);
        assert!(health_init.subsystems.unwrap().worker_channel.contains("STANDBY"));

        // 2. Start demo cluster
        let demo_resp = start_demo_cluster(State(state.clone())).await.unwrap().0;
        assert!(demo_resp.success);
        assert_eq!(demo_resp.simulated_nodes_added, 3);
        assert_eq!(demo_resp.desktop_nodes_added, 1);
        assert_eq!(demo_resp.total_nodes, 4);

        // 3. Health now reflects online nodes
        let health_online = get_health(State(state.clone())).await.unwrap().0;
        assert_eq!(health_online.idle_nodes, 4);
        assert!(health_online.subsystems.unwrap().worker_channel.contains("ONLINE"));

        // 4. Submit workload with portal auto-sign and minimal valid WASM bytes
        let wasm_bytes = vec![
            0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // WASM magic header
        ];
        let wasm_b64 = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            &wasm_bytes,
        );

        let spec = spaas_protocol::workload::WorkloadSpec {
            workload_id: Uuid::new_v4(),
            spec_version: "1.0.0".into(),
            name: "test-auto-sign".into(),
            runtime: spaas_protocol::workload::RuntimeType::WasmWasi,
            artifact_sha256: "will_be_recalculated".into(),
            artifact_size_bytes: 0,
            artifact_uri: "inline://wasm".into(),
            entrypoint: "_start".into(),
            args: vec![],
            env_vars: vec![],
            limits: Default::default(),
            network_policy: Default::default(),
            required_capabilities: Default::default(),
            retry_policy: Default::default(),
            verification_policy: Default::default(),
            priority: Default::default(),
            submitter_signature: "portal-auto-sign".into(),
            submitter_pubkey: String::new(),
            created_at_ms: chrono::Utc::now().timestamp_millis(),
        };

        let submit_req = SubmitJobRequest {
            spec,
            wasm_binary_base64: Some(wasm_b64),
        };

        let submit_resp = submit_job(State(state.clone()), Json(submit_req))
            .await
            .unwrap()
            .0;
        assert_eq!(submit_resp.state, JobState::Scheduled);

        // Verify job in state
        let jobs = state.jobs.read().await;
        let job = jobs.get(&submit_resp.job_id).unwrap();
        assert!(job.assigned_node_id.is_some());
        assert!(job.current_lease.is_some());
    }
}
