use spaas_protocol::node::*;
use spaas_protocol::workload::*;
use spaas_scheduler_core::{EdgeScheduler, SchedulerConfig};
use uuid::Uuid;

fn make_test_spec() -> WorkloadSpec {
    WorkloadSpec {
        workload_id: Uuid::new_v4(),
        spec_version: "1.0.0".into(),
        name: "scoring_test".into(),
        runtime: RuntimeType::WasmWasi,
        artifact_sha256: "hash".into(),
        artifact_size_bytes: 100,
        artifact_uri: "uri".into(),
        entrypoint: "_start".into(),
        args: vec![],
        env_vars: vec![],
        limits: ResourceLimits::default(),
        network_policy: NetworkPolicy::None,
        required_capabilities: RequiredCapabilities {
            architectures: vec!["aarch64".into()],
            min_ram_mb: 1024,
            min_battery_pct: 30,
            require_charging: false,
            require_unmetered_network: true,
            max_thermal_level: "MODERATE".into(),
            required_accelerator: None,
        },
        retry_policy: RetryPolicy::default(),
        verification_policy: VerificationPolicy::SingleNode,
        priority: WorkloadPriority::Normal,
        submitter_signature: "sig".into(),
        submitter_pubkey: "pub".into(),
        created_at_ms: 1000,
    }
}

fn make_base_node(id: Uuid) -> NodeRecord {
    NodeRecord {
        node_id: id,
        public_key: format!("key_{id}"),
        device_type: NodeDeviceType::AndroidSmartphone,
        enrollment: EnrollmentStatus::Enrolled,
        state: NodeState::Idle,
        capabilities: NodeHardwareCapabilities {
            architecture: "aarch64".into(),
            total_ram_mb: 8192,
            ..Default::default()
        },
        telemetry: NodeTelemetry {
            battery_pct: 80,
            charging_state: ChargingState::ChargingAc,
            thermal_status: ThermalStatus::None,
            network_type: NetworkType::WifiUnmetered,
            available_ram_mb: 4096,
            reliability_score: 0.95,
            ..Default::default()
        },
        policy: ProviderPolicy::default(),
        enrolled_at_ms: 0,
        last_heartbeat_ms: 0,
        region: "us".into(),
        is_simulated: false,
    }
}

#[test]
fn test_scheduler_thermal_filter_and_scoring() {
    let scheduler = EdgeScheduler::new(SchedulerConfig::default());
    let spec = make_test_spec();

    let cool_node_id = Uuid::new_v4();
    let hot_node_id = Uuid::new_v4();

    let cool_node = make_base_node(cool_node_id);
    let mut hot_node = make_base_node(hot_node_id);
    // Severe thermal status should cause policy or capability cutoff
    hot_node.telemetry.thermal_status = ThermalStatus::Severe;

    let nodes = vec![cool_node, hot_node];
    let selected = scheduler.schedule_workload(&spec, &nodes).unwrap();

    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0], cool_node_id, "Cool node must be selected over overheated node");
}

#[test]
fn test_scheduler_unmetered_network_filter() {
    let scheduler = EdgeScheduler::new(SchedulerConfig::default());
    let spec = make_test_spec();

    let wifi_node_id = Uuid::new_v4();
    let cellular_node_id = Uuid::new_v4();

    let wifi_node = make_base_node(wifi_node_id);
    let mut cellular_node = make_base_node(cellular_node_id);
    cellular_node.telemetry.network_type = NetworkType::CellularMetered;

    let nodes = vec![wifi_node, cellular_node];
    let selected = scheduler.schedule_workload(&spec, &nodes).unwrap();

    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0], wifi_node_id, "Wi-Fi node must be selected when unmetered network is required");
}

#[test]
fn test_scheduler_charging_preference() {
    let scheduler = EdgeScheduler::new(SchedulerConfig::default());
    let spec = make_test_spec();

    let charging_node_id = Uuid::new_v4();
    let discharging_node_id = Uuid::new_v4();

    let mut charging_node = make_base_node(charging_node_id);
    charging_node.telemetry.charging_state = ChargingState::ChargingAc;
    charging_node.telemetry.battery_pct = 70;

    let mut discharging_node = make_base_node(discharging_node_id);
    discharging_node.policy.only_while_charging = false;
    discharging_node.telemetry.charging_state = ChargingState::Discharging;
    discharging_node.telemetry.battery_pct = 70;

    let nodes = vec![charging_node, discharging_node];
    let selected = scheduler.schedule_workload(&spec, &nodes).unwrap();

    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0], charging_node_id, "Charging node must be scored higher than discharging node");
}
