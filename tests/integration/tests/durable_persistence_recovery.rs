use spaas_metering::MeteringLedger;
use spaas_persistence::{AuditRecord, DurableStorage, WalEvent};
use spaas_protocol::job::{JobLease, JobRecord, JobState};
use spaas_protocol::metering::{MeteringRecord, ResourceUsage};
use spaas_protocol::node::{
    EnrollmentStatus, NodeHardwareCapabilities, NodeRecord, NodeState, NodeTelemetry,
    ProviderPolicy,
};
use spaas_protocol::workload::*;
use tempfile::tempdir;
use uuid::Uuid;

#[tokio::test]
async fn test_control_plane_durable_restart_recovery() {
    let dir = tempdir().unwrap();
    let data_path = dir.path().to_path_buf();

    let node_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let lease_id = Uuid::new_v4();

    // 1. First run: Initialize storage, record entities, grant leases, and meter jobs
    {
        let storage = DurableStorage::open(&data_path).expect("Failed to open storage");

        let node = NodeRecord {
            node_id,
            public_key: "node_pubkey_hex_12345".into(),
            device_type: spaas_protocol::node::NodeDeviceType::LinuxDesktop,
            enrollment: EnrollmentStatus::Enrolled,
            state: NodeState::Active,
            capabilities: NodeHardwareCapabilities {
                architecture: "x86_64".into(),
                cpu_cores: 16,
                total_ram_mb: 32768,
                total_storage_mb: 512000,
                device_model: "Worker Station 1".into(),
                os_name: "Linux".into(),
                os_version: "6.8.0".into(),
                has_npu: false,
                has_gpu_vulkan: true,
                agent_version: "0.1.0".into(),
                supported_runtimes: vec!["wasm_wasi".into()],
            },
            telemetry: NodeTelemetry::default(),
            policy: ProviderPolicy::default(),
            qualification: None,
            enrolled_at_ms: 1000,
            last_heartbeat_ms: 2000,
            region: "us-east-1".into(),
            is_simulated: false,
        };

        storage
            .append_event(WalEvent::UpsertNode { node })
            .await
            .unwrap();

        let spec = WorkloadSpec {
            workload_id: job_id,
            spec_version: "1.0.0".into(),
            name: "matrix_computation".into(),
            runtime: RuntimeType::WasmWasi,
            artifact_sha256: "hash_abcdef".into(),
            artifact_size_bytes: 4096,
            artifact_uri: "inline://hash_abcdef".into(),
            entrypoint: "_start".into(),
            args: vec![],
            env_vars: vec![],
            limits: ResourceLimits::default(),
            network_policy: NetworkPolicy::None,
            required_capabilities: RequiredCapabilities::default(),
            retry_policy: RetryPolicy::default(),
            verification_policy: VerificationPolicy::SingleNode,
            priority: WorkloadPriority::High,
            submitter_signature: "sub_sig".into(),
            submitter_pubkey: "sub_pub".into(),
            created_at_ms: 1500,
        };

        let mut job = JobRecord::new(spec);
        job.state = JobState::Scheduled;
        job.assigned_node_id = Some(node_id);

        let lease = JobLease {
            lease_id,
            job_id,
            node_id,
            issued_at_ms: 2000,
            expires_at_ms: 32000,
            renewed_at_ms: 2000,
            term: 1,
        };
        job.current_lease = Some(lease.clone());

        storage
            .append_event(WalEvent::UpsertJob { job: job.clone() })
            .await
            .unwrap();
        storage
            .append_event(WalEvent::GrantLease { lease })
            .await
            .unwrap();

        let usage = ResourceUsage {
            fuel_consumed: 150_000,
            wall_time_ms: 25,
            memory_peak_bytes: 65536,
            network_ingress_bytes: 1024,
            network_egress_bytes: 512,
            storage_bytes: 0,
        };

        let metering_record = MeteringRecord::create(
            job_id,
            node_id,
            "digest_1234",
            "node_pubkey_hex_12345".into(),
            "sub_pub".into(),
            usage,
            true,
        );

        storage
            .append_event(WalEvent::AppendMetering {
                record: metering_record.clone(),
            })
            .await
            .unwrap();

        let audit = AuditRecord {
            timestamp_ms: 2500,
            event_type: "JOB_LEASE_GRANTED".into(),
            entity_id: job_id.to_string(),
            details: format!("Lease granted to node {node_id}"),
        };
        storage
            .append_event(WalEvent::AppendAudit { record: audit })
            .await
            .unwrap();

        // Perform checkpoint snapshot
        storage.checkpoint_snapshot().await.unwrap();

        // Add one more event after snapshot to verify incremental WAL replay
        let post_snap_audit = AuditRecord {
            timestamp_ms: 3000,
            event_type: "POST_SNAPSHOT_EVENT".into(),
            entity_id: "system".into(),
            details: "Event recorded after snapshot".into(),
        };
        storage
            .append_event(WalEvent::AppendAudit {
                record: post_snap_audit,
            })
            .await
            .unwrap();

        // Dropping storage simulates immediate crash/kill
    }

    // 2. Second run: Reopen storage after process crash
    {
        let restored_storage = DurableStorage::open(&data_path).expect("Failed to reopen storage");
        let initial_state = &restored_storage.initial_state;

        // Verify Node recovered
        assert_eq!(initial_state.nodes.len(), 1);
        let recovered_node = initial_state.nodes.get(&node_id).expect("Node must exist");
        assert_eq!(recovered_node.capabilities.device_model, "Worker Station 1");
        assert_eq!(recovered_node.state, NodeState::Active);

        // Verify Job recovered
        assert_eq!(initial_state.jobs.len(), 1);
        let recovered_job = initial_state.jobs.get(&job_id).expect("Job must exist");
        assert_eq!(recovered_job.spec.name, "matrix_computation");
        assert_eq!(recovered_job.state, JobState::Scheduled);
        assert!(recovered_job.current_lease.is_some());
        assert_eq!(
            recovered_job.current_lease.as_ref().unwrap().lease_id,
            lease_id
        );

        // Verify Metering recovered
        assert_eq!(initial_state.metering_records.len(), 1);
        assert_eq!(initial_state.metering_records[0].job_id, job_id);
        assert!(initial_state.metering_records[0].credits_earned_by_node > 0);

        // Verify Audit records recovered (including the one written after the checkpoint snapshot)
        assert_eq!(initial_state.audit_log.len(), 2);
        assert_eq!(initial_state.audit_log[0].event_type, "JOB_LEASE_GRANTED");
        assert_eq!(initial_state.audit_log[1].event_type, "POST_SNAPSHOT_EVENT");

        // Verify ledger rebuild
        let mut ledger = MeteringLedger::new();
        for record in &initial_state.metering_records {
            let res = ledger.record_job_execution(
                record.job_id,
                record.node_id,
                &record.idempotency_key,
                &record.provider_public_key,
                &record.submitter_public_key,
                record.usage.clone(),
                record.is_verified,
            );
            assert!(res.is_ok());
        }
        let account = ledger
            .get_account("node_pubkey_hex_12345")
            .expect("Account must exist");
        assert!(account.balance_credits > 0);
    }
}
