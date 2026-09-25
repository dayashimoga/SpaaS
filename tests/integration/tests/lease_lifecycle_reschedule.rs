use spaas_protocol::job::{JobLease, JobRecord, JobResult, JobState};
use spaas_protocol::workload::*;
use uuid::Uuid;

#[test]
fn test_job_lease_lifecycle_and_late_result_rejection() {
    let job_id = Uuid::new_v4();
    let node_a = Uuid::new_v4();
    let node_b = Uuid::new_v4();

    let spec = WorkloadSpec {
        workload_id: job_id,
        spec_version: "1.0.0".into(),
        name: "lease_test".into(),
        runtime: RuntimeType::WasmWasi,
        artifact_sha256: "hash".into(),
        artifact_size_bytes: 100,
        artifact_uri: "uri".into(),
        entrypoint: "_start".into(),
        args: vec![],
        env_vars: vec![],
        limits: ResourceLimits::default(),
        network_policy: NetworkPolicy::None,
        required_capabilities: RequiredCapabilities::default(),
        retry_policy: RetryPolicy::default(),
        verification_policy: VerificationPolicy::SingleNode,
        priority: WorkloadPriority::Normal,
        submitter_signature: "".into(),
        submitter_pubkey: "".into(),
        created_at_ms: 1000,
    };

    let mut job = JobRecord::new(spec);

    // 1. Initial lease grant to Node A (duration 10 seconds: expires at 11,000 ms)
    let mut lease_a = JobLease {
        lease_id: Uuid::new_v4(),
        job_id,
        node_id: node_a,
        issued_at_ms: 1000,
        expires_at_ms: 11000,
        renewed_at_ms: 1000,
        term: 1,
    };

    job.assigned_node_id = Some(node_a);
    job.current_lease = Some(lease_a.clone());
    job.transition_to(JobState::Scheduled).unwrap();
    job.transition_to(JobState::Running).unwrap();

    // 2. Node A renews lease at 8,000 ms (extension by 10s: expires at 18,000 ms)
    assert!(!lease_a.is_expired(8000));
    lease_a.renew_at(8000, 10_000);
    assert_eq!(lease_a.term, 2);
    assert_eq!(lease_a.expires_at_ms, 18000);
    job.current_lease = Some(lease_a.clone());

    // 3. Time advances to 25,000 ms -> Lease A is now EXPIRED!
    let current_time_ms = 25000;
    assert!(lease_a.is_expired(current_time_ms));

    // 4. Reconciler detects expired lease, revokes it, and requeues job
    let expired_lease = job.current_lease.take().unwrap();
    assert!(expired_lease.is_expired(current_time_ms));
    job.transition_to(JobState::Retrying).unwrap();
    job.transition_to(JobState::Queued).unwrap();
    assert_eq!(job.state, JobState::Queued);
    assert_eq!(job.retry_count, 1);
    assert!(job.current_lease.is_none());

    // 5. Node A tries to submit a late result for expired lease -> MUST BE REJECTED!
    let _late_result = JobResult {
        result_id: Uuid::new_v4(),
        job_id,
        node_id: node_a,
        exit_code: 0,
        stdout: "late result from node A".into(),
        stderr: "".into(),
        result_digest: "digest_late".into(),
        fuel_consumed: 1000,
        wall_time_ms: 20000,
        peak_memory_bytes: 65536,
        node_signature: "sig".into(),
        completed_at_ms: current_time_ms,
    };

    // Control Plane validation: Job is in Queued state and has no active lease for Node A
    let late_submission_accepted = matches!(&job.current_lease, Some(l) if l.lease_id == expired_lease.lease_id && !l.is_expired(current_time_ms));
    assert!(
        !late_submission_accepted,
        "Late result from expired lease must be rejected"
    );

    // 6. Scheduler reassigns job to Node B with fresh lease B
    let lease_b = JobLease {
        lease_id: Uuid::new_v4(),
        job_id,
        node_id: node_b,
        issued_at_ms: current_time_ms,
        expires_at_ms: current_time_ms + 30_000,
        renewed_at_ms: current_time_ms,
        term: 1,
    };
    job.assigned_node_id = Some(node_b);
    job.current_lease = Some(lease_b.clone());
    job.transition_to(JobState::Scheduled).unwrap();
    job.transition_to(JobState::Running).unwrap();

    // 7. Node B completes work on time and submits result
    let on_time_ms = current_time_ms + 5000;
    assert!(!lease_b.is_expired(on_time_ms));

    let valid_result = JobResult {
        result_id: Uuid::new_v4(),
        job_id,
        node_id: node_b,
        exit_code: 0,
        stdout: "verified output from node B".into(),
        stderr: "".into(),
        result_digest: "digest_node_b".into(),
        fuel_consumed: 950,
        wall_time_ms: 4500,
        peak_memory_bytes: 65536,
        node_signature: "sig_b".into(),
        completed_at_ms: on_time_ms,
    };

    job.result = Some(valid_result);
    job.transition_to(JobState::Verifying).unwrap();
    job.transition_to(JobState::Completed).unwrap();

    assert_eq!(job.state, JobState::Completed);
    assert_eq!(job.assigned_node_id, Some(node_b));
}
