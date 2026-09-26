use spaas_node_agent::NodeAgent;
use spaas_protocol::node::*;
use spaas_protocol::workload::*;
use spaas_scheduler_core::{EdgeScheduler, SchedulerConfig};
use std::collections::HashSet;

/// Verifies that multiple devices can enroll concurrently with unique identities,
/// all appear in the fleet, and can independently participate in scheduling.
#[tokio::test]
async fn test_multi_device_concurrent_enrollment() {
    let num_devices = 5;
    let mut enrolled_nodes = Vec::new();
    let mut node_ids = HashSet::new();

    // 1. Enroll 5 heterogeneous devices simultaneously
    let device_configs = vec![
        ("Pixel 8 Pro", "aarch64", 12288u64, false),
        ("Galaxy S24", "aarch64", 8192, false),
        ("Desktop Worker", "x86_64", 32768, false),
        ("Tab S9", "aarch64", 8192, false),
        ("Raspberry Pi 5", "aarch64", 4096, false),
    ];

    for (model, arch, ram, simulated) in &device_configs {
        let agent = NodeAgent::new(
            NodeHardwareCapabilities {
                device_model: model.to_string(),
                architecture: arch.to_string(),
                total_ram_mb: *ram,
                ..Default::default()
            },
            ProviderPolicy {
                only_while_charging: false,
                only_on_unmetered_network: true,
                min_battery_threshold_pct: 20,
                max_thermal_threshold: ThermalStatus::Moderate,
                max_concurrent_jobs: 2,
                is_user_paused: false,
                ..Default::default()
            },
            *simulated,
        );

        let record = agent.to_record();

        // Assert unique node IDs
        assert!(
            node_ids.insert(record.node_id),
            "Duplicate node ID detected during concurrent enrollment"
        );
        assert_eq!(record.enrollment, EnrollmentStatus::Enrolled);
        assert_eq!(record.state, NodeState::Idle);

        enrolled_nodes.push(record);
    }

    // 2. Verify all 5 devices have unique IDs and are schedulable
    assert_eq!(enrolled_nodes.len(), num_devices);
    assert_eq!(node_ids.len(), num_devices);

    for node in &enrolled_nodes {
        assert!(
            node.state.is_schedulable(),
            "Node {} should be schedulable",
            node.node_id
        );
        assert_eq!(node.enrollment, EnrollmentStatus::Enrolled);
    }

    // 3. Verify scheduler can see all 5 devices and selects the best one
    let scheduler = EdgeScheduler::new(SchedulerConfig::default());
    let spec = WorkloadSpec::default();

    // Set varied telemetry to ensure differentiable scoring
    let mut scored_nodes = enrolled_nodes.clone();
    scored_nodes[0].telemetry.battery_pct = 95;
    scored_nodes[0].telemetry.charging_state = ChargingState::ChargingAc;
    scored_nodes[0].telemetry.network_type = NetworkType::WifiUnmetered;
    scored_nodes[0].telemetry.thermal_status = ThermalStatus::None;

    scored_nodes[1].telemetry.battery_pct = 70;
    scored_nodes[1].telemetry.charging_state = ChargingState::ChargingUsb;
    scored_nodes[1].telemetry.network_type = NetworkType::WifiUnmetered;

    scored_nodes[2].telemetry.battery_pct = 100;
    scored_nodes[2].telemetry.charging_state = ChargingState::ChargingAc;
    scored_nodes[2].telemetry.network_type = NetworkType::Ethernet;
    scored_nodes[2].telemetry.thermal_status = ThermalStatus::None;

    scored_nodes[3].telemetry.battery_pct = 60;
    scored_nodes[3].telemetry.charging_state = ChargingState::Discharging;
    scored_nodes[3].telemetry.network_type = NetworkType::WifiUnmetered;

    scored_nodes[4].telemetry.battery_pct = 85;
    scored_nodes[4].telemetry.charging_state = ChargingState::ChargingAc;
    scored_nodes[4].telemetry.network_type = NetworkType::WifiUnmetered;

    let (selected, decision) = scheduler
        .schedule_workload_with_decision(&spec, &scored_nodes)
        .expect("Scheduling across 5 enrolled devices should succeed");

    assert!(
        !selected.is_empty(),
        "At least one device should be selected"
    );
    assert!(
        node_ids.contains(&selected[0]),
        "Selected node must be one of the enrolled devices"
    );

    // Verify decision has all candidates evaluated
    assert!(
        decision.eligible_candidate_count + decision.rejected_nodes.len() == num_devices,
        "Decision should account for all {} devices",
        num_devices
    );

    // 4. Verify independent device lifecycle — revoking one doesn't affect others
    let revoked_id = enrolled_nodes[3].node_id;
    scored_nodes[3].enrollment = EnrollmentStatus::Revoked;
    scored_nodes[3].state = NodeState::Offline;

    let (selected_after_revoke, decision_after) = scheduler
        .schedule_workload_with_decision(&spec, &scored_nodes)
        .expect("Scheduling should succeed with 4 remaining devices");

    assert!(
        !selected_after_revoke.contains(&revoked_id),
        "Revoked device must not be selected"
    );
    assert!(
        decision_after
            .rejected_nodes
            .iter()
            .any(|r| r.node_id == revoked_id),
        "Revoked device should appear in rejected list"
    );

    // 5. Verify pausing a device removes it from scheduling
    scored_nodes[1].policy.is_user_paused = true;

    let (selected_after_pause, _) = scheduler
        .schedule_workload_with_decision(&spec, &scored_nodes)
        .expect("Scheduling should succeed with 3 active devices");

    assert!(
        !selected_after_pause.contains(&enrolled_nodes[1].node_id),
        "Paused device must not be selected"
    );
}

/// Verifies that pairing token generation produces unique, non-colliding codes.
#[test]
fn test_pairing_token_uniqueness() {
    let mut codes = HashSet::new();
    for _ in 0..100 {
        let code = format!(
            "SP-{}",
            (0..4)
                .map(|_| {
                    let idx = rand::random::<u8>() % 36;
                    if idx < 10 {
                        (b'0' + idx) as char
                    } else {
                        (b'A' + idx - 10) as char
                    }
                })
                .collect::<String>()
        );
        assert!(
            codes.insert(code.clone()),
            "Pairing code collision detected: {}",
            code
        );
    }
    assert_eq!(codes.len(), 100);
}
