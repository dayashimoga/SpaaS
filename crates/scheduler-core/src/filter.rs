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
