use crate::state::AppState;
use spaas_protocol::metering::ResourceUsage;
use spaas_persistence::WalEvent;
use spaas_protocol::job::{JobLease, JobResult, JobState};
use spaas_protocol::node::{NodeRecord, NodeState};
use spaas_protocol::rpc::JobDispatchMessage;
use spaas_security::keys::KeyPair;
use spaas_security::signing::sign_message;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tracing::{info, warn};

pub async fn run_reconciler_loop(state: AppState) {
    let mut interval = tokio::time::interval(Duration::from_millis(1500));

    loop {
        interval.tick().await;

        let now = chrono::Utc::now().timestamp_millis();
        let timeout_thresh = now - 20_000; // 20s heartbeat timeout

        // 1. Detect disconnected nodes & maintain simulated nodes
        let mut offline_node_ids = Vec::new();
        {
            let mut nodes = state.nodes.write().await;
            for (node_id, node) in nodes.iter_mut() {
                if node.is_simulated {
                    // Keep simulated demo nodes actively healthy
                    node.last_heartbeat_ms = now;
                    if node.state == NodeState::Offline {
                        node.state = NodeState::Idle;
                    }
                    continue;
                }
                if node.state != NodeState::Offline && node.last_heartbeat_ms < timeout_thresh {
                    node.state = NodeState::Offline;
                    offline_node_ids.push(*node_id);
                    state.metrics.offline_nodes.fetch_add(1, Ordering::Relaxed);
                    state.metrics.active_nodes.fetch_sub(1, Ordering::Relaxed);
                    warn!(node_id = %node_id, "Node missed heartbeats; marked OFFLINE");

                    let updated = node.clone();
                    let _ = state
                        .storage
                        .append_event(WalEvent::UpsertNode { node: updated })
                        .await;
                }
            }
        }

        // 2. Identify jobs with dead nodes, timeouts, or expired leases
        let mut jobs_to_reschedule = Vec::new();
        {
            let mut jobs = state.jobs.write().await;
            for (job_id, job) in jobs.iter_mut() {
                if job.state == JobState::Scheduled || job.state == JobState::Running {
                    let node_died = if let Some(assigned_id) = job.assigned_node_id {
                        offline_node_ids.contains(&assigned_id)
                    } else {
                        false
                    };

                    let is_timed_out = if let Some(started) = job.started_at_ms {
                        now - started > (job.spec.limits.timeout_ms as i64)
                    } else {
                        false
                    };

                    let is_lease_expired = if let Some(ref lease) = job.current_lease {
                        lease.is_expired(now)
                    } else {
                        false
                    };

                    if node_died || is_timed_out || is_lease_expired {
                        let expired_lease = job.current_lease.take();
                        if let Some(l) = expired_lease {
                            let _ = state
                                .storage
                                .append_event(WalEvent::RevokeLease {
                                    job_id: *job_id,
                                    lease_id: l.lease_id,
                                })
                                .await;
                        }

                        if job.retry_count < job.spec.retry_policy.max_retries {
                            let reason = if is_lease_expired {
                                "Job lease expired without result; recovering and requeuing job"
                            } else if node_died {
                                "Assigned node disconnected; recovering and requeuing job"
                            } else {
                                "Execution timed out; recovering and requeuing job"
                            };

                            warn!(
                                job_id = %job_id,
                                retry = job.retry_count + 1,
                                max = job.spec.retry_policy.max_retries,
                                "{reason}"
                            );

                            let _ = job.transition_to(JobState::Retrying);
                            let _ = job.transition_to(JobState::Queued);
                            state.metrics.retried_jobs.fetch_add(1, Ordering::Relaxed);
                            jobs_to_reschedule.push(*job_id);

                            let updated_job = job.clone();
                            let _ = state
                                .storage
                                .append_event(WalEvent::UpsertJob { job: updated_job })
                                .await;
                        } else {
                            warn!(
                                job_id = %job_id,
                                "Job exceeded max retries; marking FAILED"
                            );
                            let _ = job.transition_to(JobState::Failed);
                            job.error_message = Some(
                                "Node disappeared or lease expired with retries exhausted".into(),
                            );
                            state.metrics.failed_jobs.fetch_add(1, Ordering::Relaxed);

                            let updated_job = job.clone();
                            let _ = state
                                .storage
                                .append_event(WalEvent::UpsertJob { job: updated_job })
                                .await;
                        }
                    }
                }
            }
        }

        // 3. Attempt to schedule pending queued jobs
        let eligible_nodes: Vec<NodeRecord> = {
            let nodes = state.nodes.read().await;
            nodes.values().cloned().collect()
        };

        let queued_job_ids: Vec<uuid::Uuid> = {
            let jobs = state.jobs.read().await;
            jobs.iter()
                .filter(|(_, j)| j.state == JobState::Queued)
                .map(|(id, _)| *id)
                .collect()
        };

        for q_id in queued_job_ids {
            let mut jobs = state.jobs.write().await;
            if let Some(job) = jobs.get_mut(&q_id) {
                if let Ok(selected) = state
                    .scheduler
                    .schedule_workload(&job.spec, &eligible_nodes)
                {
                    if !selected.is_empty() {
                        let primary = selected[0];
                        let lease = JobLease::new(q_id, primary, 30_000);

                        job.assigned_node_id = Some(primary);
                        job.current_lease = Some(lease.clone());
                        let _ = job.transition_to(JobState::Scheduled);

                        let artifacts = state.wasm_artifacts.read().await;
                        let wasm_bytes = artifacts.get(&job.spec.artifact_sha256).cloned();

                        let dispatch = JobDispatchMessage {
                            job_id: q_id,
                            lease_id: lease.lease_id,
                            lease_expires_at_ms: lease.expires_at_ms,
                            spec: job.spec.clone(),
                            wasm_bytes,
                            dispatched_at_ms: now,
                        };

                        let mut dispatches = state.dispatches.write().await;
                        dispatches.insert(primary, dispatch);

                        let updated_job = job.clone();
                        let _ = state
                            .storage
                            .append_event(WalEvent::GrantLease { lease })
                            .await;
                        let _ = state
                            .storage
                            .append_event(WalEvent::UpsertJob { job: updated_job })
                            .await;

                        info!(job_id = %q_id, node_id = %primary, "Queued job scheduled by reconciler with renewable lease");
                    }
                }
            }
        }

        // 4. Auto-execute jobs scheduled onto simulated demo nodes
        let mut sim_jobs = Vec::new();
        {
            let jobs = state.jobs.read().await;
            let nodes = state.nodes.read().await;
            for (job_id, job) in jobs.iter() {
                if job.state == JobState::Scheduled {
                    if let Some(nid) = job.assigned_node_id {
                        if let Some(node) = nodes.get(&nid) {
                            if node.is_simulated {
                                sim_jobs.push((*job_id, nid, node.public_key.clone(), job.spec.name.clone(), job.spec.submitter_pubkey.clone()));
                            }
                        }
                    }
                }
            }
        }

        for (job_id, node_id, node_pubkey, name, submitter_pubkey) in sim_jobs {
            let stdout = if name.contains("hello") {
                "Hello from SPaaS Edge Compute Fabric!".to_string()
            } else if name.contains("sha256") {
                "SHA-256 Benchmark: 10,000 hashes verified in 18ms".to_string()
            } else if name.contains("prime") {
                "Prime Sieve: 1,229 primes computed up to 10,000".to_string()
            } else if name.contains("matrix") {
                "Matrix Multiply: 64x64 matrix computation verified".to_string()
            } else {
                format!("Workload '{name}' executed successfully on edge node.")
            };

            let fuel = 45_000u64;
            let wall_ms = 32u64;
            let result_digest = JobResult::compute_digest(0, &stdout, "", fuel);
            let dummy_key = KeyPair::generate();
            let node_signature = sign_message(&dummy_key, result_digest.as_bytes());

            let result = JobResult {
                result_id: uuid::Uuid::new_v4(),
                job_id,
                node_id,
                exit_code: 0,
                stdout,
                stderr: String::new(),
                result_digest: result_digest.clone(),
                fuel_consumed: fuel,
                wall_time_ms: wall_ms,
                peak_memory_bytes: 1048576,
                node_signature,
                completed_at_ms: now,
            };

            let usage = ResourceUsage {
                fuel_consumed: fuel,
                wall_time_ms: wall_ms,
                memory_peak_bytes: 1048576,
                network_ingress_bytes: 4096,
                network_egress_bytes: 512,
                storage_bytes: 0,
            };

            // Transition job to Running, then Completed
            let job_snapshot = {
                let mut jobs = state.jobs.write().await;
                if let Some(job) = jobs.get_mut(&job_id) {
                    let _ = job.transition_to(JobState::Running);
                    let _ = job.transition_to(JobState::Verifying);
                    job.result = Some(result.clone());
                    let _ = job.transition_to(JobState::Completed);
                    job.credit_cost = Some(50);
                    job.clone()
                } else {
                    continue;
                }
            };

            // Remove dispatch if any
            {
                let mut dispatches = state.dispatches.write().await;
                dispatches.remove(&node_id);
            }

            // Metering record
            let credits = {
                let mut ledger = state.ledger.write().await;
                if let Ok(rec) = ledger.record_job_execution(
                    job_id,
                    node_id,
                    &result_digest,
                    &node_pubkey,
                    &submitter_pubkey,
                    usage,
                    true,
                ) {
                    rec.credits_earned_by_node
                } else {
                    50
                }
            };

            state.metrics.completed_jobs.fetch_add(1, Ordering::Relaxed);
            let _ = state
                .storage
                .append_event(WalEvent::UpsertJob { job: job_snapshot })
                .await;

            info!(job_id = %job_id, "Simulated demo node executed workload to COMPLETED");
            state.broadcast_event(
                "JOB_COMPLETED",
                serde_json::json!({
                    "job_id": job_id,
                    "node_id": node_id,
                    "credits_earned": credits
                }),
            );
        }
    }
}
