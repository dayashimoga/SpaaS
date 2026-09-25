use spaas_protocol::node::{EnrollmentStatus, NodeRecord, NodeState, ThermalStatus};
use spaas_protocol::workload::WorkloadSpec;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FilterRejectionReason {
    NotEnrolled,
    NodeOfflineOrPaused,
    UserExplicitlyPaused,
    MaxConcurrentJobsReached,
    ArchitectureMismatch { required: Vec<String>, actual: String },
    InsufficientRam { required_mb: u64, available_mb: u64 },
    BatteryTooLow { threshold_pct: u8, actual_pct: u8 },
    ChargingRequiredNotMet,
    UnmeteredNetworkRequiredNotMet,
    ThermalThrottled { max_allowed: ThermalStatus, actual: ThermalStatus },
}

/// Evaluates if a node is strictly eligible to execute a given workload
pub fn evaluate_node_eligibility(
    node: &NodeRecord,
    spec: &WorkloadSpec,
) -> Result<(), FilterRejectionReason> {
    // 1. Enrollment check
    if node.enrollment != EnrollmentStatus::Enrolled {
        return Err(FilterRejectionReason::NotEnrolled);
    }

    // 2. Operational state
    if node.state != NodeState::Idle && node.state != NodeState::Active {
        return Err(FilterRejectionReason::NodeOfflineOrPaused);
    }

    // 3. User provider pause
    if node.policy.is_user_paused {
        return Err(FilterRejectionReason::UserExplicitlyPaused);
    }

    // 4. Capacity limit
    if node.telemetry.active_job_count >= node.policy.max_concurrent_jobs {
        return Err(FilterRejectionReason::MaxConcurrentJobsReached);
    }

    // 5. Architecture match
    let req_caps = &spec.required_capabilities;
    if !req_caps.architectures.is_empty()
        && !req_caps.architectures.iter().any(|arch| {
            arch.eq_ignore_ascii_case(&node.capabilities.architecture)
                || arch == "*"
        })
    {
        return Err(FilterRejectionReason::ArchitectureMismatch {
            required: req_caps.architectures.clone(),
            actual: node.capabilities.architecture.clone(),
        });
    }

    // 6. RAM requirement
    if node.telemetry.available_ram_mb < req_caps.min_ram_mb {
        return Err(FilterRejectionReason::InsufficientRam {
            required_mb: req_caps.min_ram_mb,
            available_mb: node.telemetry.available_ram_mb,
        });
    }

    // 7. Battery threshold (max of workload requirement and node policy)
    let min_battery = req_caps.min_battery_pct.max(node.policy.min_battery_threshold_pct);
    if node.telemetry.battery_pct < min_battery {
        return Err(FilterRejectionReason::BatteryTooLow {
            threshold_pct: min_battery,
            actual_pct: node.telemetry.battery_pct,
        });
    }

    // 8. Charging requirement
    let requires_charging = req_caps.require_charging || node.policy.only_while_charging;
    if requires_charging && !node.telemetry.charging_state.is_charging() {
        return Err(FilterRejectionReason::ChargingRequiredNotMet);
    }

    // 9. Network requirement
    let requires_unmetered = req_caps.require_unmetered_network || node.policy.only_on_unmetered_network;
    if requires_unmetered && !node.telemetry.network_type.is_unmetered() {
        return Err(FilterRejectionReason::UnmeteredNetworkRequiredNotMet);
    }

    // 10. Thermal threshold
    let policy_max_thermal = node.policy.max_thermal_threshold;
    if node.telemetry.thermal_status > policy_max_thermal {
        return Err(FilterRejectionReason::ThermalThrottled {
            max_allowed: policy_max_thermal,
            actual: node.telemetry.thermal_status,
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use spaas_protocol::node::*;
    use uuid::Uuid;

    fn make_test_node() -> NodeRecord {
        NodeRecord {
            node_id: Uuid::new_v4(),
            public_key: "pubkey".into(),
            device_type: NodeDeviceType::AndroidSmartphone,
            enrollment: EnrollmentStatus::Enrolled,
            state: NodeState::Idle,
            capabilities: NodeHardwareCapabilities {
                architecture: "aarch64".into(),
                ..Default::default()
            },
            telemetry: NodeTelemetry {
                battery_pct: 80,
                charging_state: ChargingState::ChargingAc,
                network_type: NetworkType::WifiUnmetered,
                thermal_status: ThermalStatus::None,
                available_ram_mb: 2048,
                active_job_count: 0,
                ..Default::default()
            },
            policy: ProviderPolicy {
                only_while_charging: true,
                only_on_unmetered_network: true,
                min_battery_threshold_pct: 30,
                max_thermal_threshold: ThermalStatus::Moderate,
                max_concurrent_jobs: 1,
                is_user_paused: false,
                ..Default::default()
            },
            qualification: None,
            enrolled_at_ms: 1000,
            last_heartbeat_ms: 1000,
            region: "local".into(),
            is_simulated: false,
        }
    }

    #[test]
    fn test_all_filter_rejection_branches() {
        let mut node = make_test_node();
        let mut spec = WorkloadSpec::default();

        // 1. Success case
        assert!(evaluate_node_eligibility(&node, &spec).is_ok());

        // 2. Not enrolled
        node.enrollment = EnrollmentStatus::Suspended;
        assert_eq!(evaluate_node_eligibility(&node, &spec), Err(FilterRejectionReason::NotEnrolled));
        node.enrollment = EnrollmentStatus::Enrolled;

        // 3. Node offline
        node.state = NodeState::Offline;
        assert_eq!(evaluate_node_eligibility(&node, &spec), Err(FilterRejectionReason::NodeOfflineOrPaused));
        node.state = NodeState::Idle;

        // 4. User paused
        node.policy.is_user_paused = true;
        assert_eq!(evaluate_node_eligibility(&node, &spec), Err(FilterRejectionReason::UserExplicitlyPaused));
        node.policy.is_user_paused = false;

        // 5. Max concurrent jobs
        node.telemetry.active_job_count = 1;
        assert_eq!(evaluate_node_eligibility(&node, &spec), Err(FilterRejectionReason::MaxConcurrentJobsReached));
        node.telemetry.active_job_count = 0;

        // 6. Architecture mismatch
        spec.required_capabilities.architectures = vec!["x86_64".into()];
        assert!(matches!(evaluate_node_eligibility(&node, &spec), Err(FilterRejectionReason::ArchitectureMismatch { .. })));
        spec.required_capabilities.architectures = vec!["*".into()];
        assert!(evaluate_node_eligibility(&node, &spec).is_ok());
        spec.required_capabilities.architectures.clear();

        // 7. Insufficient RAM
        spec.required_capabilities.min_ram_mb = 4096;
        assert!(matches!(evaluate_node_eligibility(&node, &spec), Err(FilterRejectionReason::InsufficientRam { .. })));
        spec.required_capabilities.min_ram_mb = 512;

        // 8. Battery too low
        node.telemetry.battery_pct = 20;
        assert!(matches!(evaluate_node_eligibility(&node, &spec), Err(FilterRejectionReason::BatteryTooLow { .. })));
        node.telemetry.battery_pct = 80;

        // 9. Charging required not met
        node.telemetry.charging_state = ChargingState::Discharging;
        assert_eq!(evaluate_node_eligibility(&node, &spec), Err(FilterRejectionReason::ChargingRequiredNotMet));
        node.telemetry.charging_state = ChargingState::ChargingAc;

        // 10. Unmetered network required not met
        node.telemetry.network_type = NetworkType::CellularMetered;
        assert_eq!(evaluate_node_eligibility(&node, &spec), Err(FilterRejectionReason::UnmeteredNetworkRequiredNotMet));
        node.telemetry.network_type = NetworkType::WifiUnmetered;

        // 11. Thermal throttled
        node.telemetry.thermal_status = ThermalStatus::Severe;
        assert!(matches!(evaluate_node_eligibility(&node, &spec), Err(FilterRejectionReason::ThermalThrottled { .. })));
    }
}

