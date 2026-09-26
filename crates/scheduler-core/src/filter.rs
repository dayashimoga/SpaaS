use spaas_protocol::node::{EnrollmentStatus, NodeRecord, NodeState, ThermalStatus};
use spaas_protocol::workload::WorkloadSpec;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FilterRejectionReason {
    NotEnrolled,
    NodeOfflineOrPaused,
    UserExplicitlyPaused,
    MaxConcurrentJobsReached,
    ArchitectureMismatch {
        required: Vec<String>,
        actual: String,
    },
    InsufficientRam {
        required_mb: u64,
        available_mb: u64,
    },
    BatteryTooLow {
        threshold_pct: u8,
        actual_pct: u8,
    },
    ChargingRequiredNotMet,
    UnmeteredNetworkRequiredNotMet,
    ThermalThrottled {
        max_allowed: ThermalStatus,
        actual: ThermalStatus,
    },
    AcceleratorNotSupported {
        required: String,
    },
    RegionMismatch {
        preferred: Vec<String>,
        actual: String,
    },
    CategoryNotAllowed {
        workload_category: String,
        allowed_categories: Vec<String>,
    },
    DeadlineInfeasible {
        deadline_ms: i64,
        estimated_finish_ms: i64,
    },
    CostExceedsMax {
        estimated_cost: u64,
        max_cost: u64,
    },
}

impl FilterRejectionReason {
    pub fn failed_constraint(&self) -> &'static str {
        match self {
            Self::NotEnrolled => "ENROLLMENT",
            Self::NodeOfflineOrPaused => "NODE_STATE",
            Self::UserExplicitlyPaused => "OWNER_PAUSED",
            Self::MaxConcurrentJobsReached => "CONCURRENCY_LIMIT",
            Self::ArchitectureMismatch { .. } => "ARCHITECTURE",
            Self::InsufficientRam { .. } => "RAM_LIMIT",
            Self::BatteryTooLow { .. } => "BATTERY_THRESHOLD",
            Self::ChargingRequiredNotMet => "CHARGING_REQUIRED",
            Self::UnmeteredNetworkRequiredNotMet => "UNMETERED_NETWORK",
            Self::ThermalThrottled { .. } => "THERMAL_LIMIT",
            Self::AcceleratorNotSupported { .. } => "ACCELERATOR_REQUIRED",
            Self::RegionMismatch { .. } => "REGION_MISMATCH",
            Self::CategoryNotAllowed { .. } => "CATEGORY_NOT_ALLOWED",
            Self::DeadlineInfeasible { .. } => "DEADLINE_INFEASIBLE",
            Self::CostExceedsMax { .. } => "COST_EXCEEDS_MAX",
        }
    }

    pub fn description(&self) -> String {
        match self {
            Self::NotEnrolled => "Node enrollment is not active or suspended".into(),
            Self::NodeOfflineOrPaused => "Node is currently offline or paused".into(),
            Self::UserExplicitlyPaused => {
                "Device owner explicitly paused compute contribution".into()
            }
            Self::MaxConcurrentJobsReached => {
                "Node has reached its owner-configured max concurrent jobs".into()
            }
            Self::ArchitectureMismatch { required, actual } => {
                format!(
                    "CPU architecture mismatch: requires {:?}, node is {}",
                    required, actual
                )
            }
            Self::InsufficientRam {
                required_mb,
                available_mb,
            } => {
                format!(
                    "Insufficient free RAM: requires {} MB, available is {} MB",
                    required_mb, available_mb
                )
            }
            Self::BatteryTooLow {
                threshold_pct,
                actual_pct,
            } => {
                format!(
                    "Battery below threshold: requires >= {}%, currently at {}%",
                    threshold_pct, actual_pct
                )
            }
            Self::ChargingRequiredNotMet => {
                "Workload or node policy requires active AC/Wireless charging".into()
            }
            Self::UnmeteredNetworkRequiredNotMet => {
                "Workload or node policy requires unmetered Wi-Fi/Ethernet".into()
            }
            Self::ThermalThrottled {
                max_allowed,
                actual,
            } => {
                format!(
                    "Thermal status exceeded: allowed {:?}, current is {:?}",
                    max_allowed, actual
                )
            }
            Self::AcceleratorNotSupported { required } => {
                format!(
                    "Required accelerator '{}' not supported or denied by owner policy",
                    required
                )
            }
            Self::RegionMismatch { preferred, actual } => {
                format!(
                    "Node region '{}' not in preferred regions {:?}",
                    actual, preferred
                )
            }
            Self::CategoryNotAllowed {
                workload_category,
                allowed_categories,
            } => {
                format!(
                    "Workload category '{}' not in owner's allowed categories {:?}",
                    workload_category, allowed_categories
                )
            }
            Self::DeadlineInfeasible {
                deadline_ms,
                estimated_finish_ms,
            } => {
                format!(
                    "Workload deadline {} cannot be met; estimated completion is {}",
                    deadline_ms, estimated_finish_ms
                )
            }
            Self::CostExceedsMax {
                estimated_cost,
                max_cost,
            } => {
                format!(
                    "Estimated cost of {} credits exceeds consumer max ({} credits)",
                    estimated_cost, max_cost
                )
            }
        }
    }
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
        && !req_caps
            .architectures
            .iter()
            .any(|arch| arch.eq_ignore_ascii_case(&node.capabilities.architecture) || arch == "*")
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
    let min_battery = req_caps
        .min_battery_pct
        .max(node.policy.min_battery_threshold_pct);
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
    let requires_unmetered =
        req_caps.require_unmetered_network || node.policy.only_on_unmetered_network;
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

    // 11. Hardware accelerator check
    if let Some(ref acc) = req_caps.required_accelerator {
        let acc_lower = acc.to_lowercase();
        if acc_lower == "gpu" && (!node.capabilities.has_gpu_vulkan || !node.policy.allow_gpu) {
            return Err(FilterRejectionReason::AcceleratorNotSupported {
                required: "GPU/Vulkan".into(),
            });
        }
        if acc_lower == "npu" && (!node.capabilities.has_npu || !node.policy.allow_npu) {
            return Err(FilterRejectionReason::AcceleratorNotSupported {
                required: "NPU/AI".into(),
            });
        }
    }

    // 12. Region-based filtering (Sprint 4: GD-01)
    if !spec.preferred_regions.is_empty()
        && !spec
            .preferred_regions
            .iter()
            .any(|r| r.eq_ignore_ascii_case(&node.region) || r == "*")
    {
        return Err(FilterRejectionReason::RegionMismatch {
            preferred: spec.preferred_regions.clone(),
            actual: node.region.clone(),
        });
    }

    // 13. Workload category filtering (Sprint 5: GE-04)
    if !node.policy.allowed_categories.is_empty()
        && !spec.category.is_empty()
        && !node
            .policy
            .allowed_categories
            .iter()
            .any(|c| c.eq_ignore_ascii_case(&spec.category) || c == "*")
    {
        return Err(FilterRejectionReason::CategoryNotAllowed {
            workload_category: spec.category.clone(),
            allowed_categories: node.policy.allowed_categories.clone(),
        });
    }

    // 14. Deadline feasibility check (Sprint 4: GD-03)
    if let Some(deadline) = spec.deadline_ms {
        let now = chrono::Utc::now().timestamp_millis();
        let mips = node
            .qualification
            .as_ref()
            .map(|q| q.measured_fuel_mips)
            .unwrap_or(150.0)
            .max(1.0);
        let est_ms =
            ((spec.limits.max_fuel as f64 / (mips * 1_000_000.0)) * 1000.0).max(1.0) as i64;
        let est_finish = now + est_ms;
        if est_finish > deadline {
            return Err(FilterRejectionReason::DeadlineInfeasible {
                deadline_ms: deadline,
                estimated_finish_ms: est_finish,
            });
        }
    }

    // 15. Consumer cost budget check (Sprint 4: GD-04)
    if let Some(max_cost) = spec.max_cost_credits {
        let estimated_cost = 10 + (spec.limits.max_fuel / 100_000);
        if estimated_cost > max_cost {
            return Err(FilterRejectionReason::CostExceedsMax {
                estimated_cost,
                max_cost,
            });
        }
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
        assert_eq!(
            evaluate_node_eligibility(&node, &spec),
            Err(FilterRejectionReason::NotEnrolled)
        );
        node.enrollment = EnrollmentStatus::Enrolled;

        // 3. Node offline
        node.state = NodeState::Offline;
        assert_eq!(
            evaluate_node_eligibility(&node, &spec),
            Err(FilterRejectionReason::NodeOfflineOrPaused)
        );
        node.state = NodeState::Idle;

        // 4. User paused
        node.policy.is_user_paused = true;
        assert_eq!(
            evaluate_node_eligibility(&node, &spec),
            Err(FilterRejectionReason::UserExplicitlyPaused)
        );
        node.policy.is_user_paused = false;

        // 5. Max concurrent jobs
        node.telemetry.active_job_count = 1;
        assert_eq!(
            evaluate_node_eligibility(&node, &spec),
            Err(FilterRejectionReason::MaxConcurrentJobsReached)
        );
        node.telemetry.active_job_count = 0;

        // 6. Architecture mismatch
        spec.required_capabilities.architectures = vec!["x86_64".into()];
        assert!(matches!(
            evaluate_node_eligibility(&node, &spec),
            Err(FilterRejectionReason::ArchitectureMismatch { .. })
        ));
        spec.required_capabilities.architectures = vec!["*".into()];
        assert!(evaluate_node_eligibility(&node, &spec).is_ok());
        spec.required_capabilities.architectures.clear();

        // 7. Insufficient RAM
        spec.required_capabilities.min_ram_mb = 4096;
        assert!(matches!(
            evaluate_node_eligibility(&node, &spec),
            Err(FilterRejectionReason::InsufficientRam { .. })
        ));
        spec.required_capabilities.min_ram_mb = 512;

        // 8. Battery too low
        node.telemetry.battery_pct = 20;
        assert!(matches!(
            evaluate_node_eligibility(&node, &spec),
            Err(FilterRejectionReason::BatteryTooLow { .. })
        ));
        node.telemetry.battery_pct = 80;

        // 9. Charging required not met
        node.telemetry.charging_state = ChargingState::Discharging;
        assert_eq!(
            evaluate_node_eligibility(&node, &spec),
            Err(FilterRejectionReason::ChargingRequiredNotMet)
        );
        node.telemetry.charging_state = ChargingState::ChargingAc;

        // 10. Unmetered network required not met
        node.telemetry.network_type = NetworkType::CellularMetered;
        assert_eq!(
            evaluate_node_eligibility(&node, &spec),
            Err(FilterRejectionReason::UnmeteredNetworkRequiredNotMet)
        );
        node.telemetry.network_type = NetworkType::WifiUnmetered;

        // 11. Thermal throttled
        node.telemetry.thermal_status = ThermalStatus::Severe;
        assert!(matches!(
            evaluate_node_eligibility(&node, &spec),
            Err(FilterRejectionReason::ThermalThrottled { .. })
        ));
        node.telemetry.thermal_status = ThermalStatus::None;

        // 12. Region mismatch (Sprint 4: GD-01)
        spec.preferred_regions = vec!["eu-central".into()];
        assert!(matches!(
            evaluate_node_eligibility(&node, &spec),
            Err(FilterRejectionReason::RegionMismatch { .. })
        ));
        spec.preferred_regions = vec![];

        // 13. Category not allowed (Sprint 5: GE-04)
        node.policy.allowed_categories = vec!["ai_inference".into()];
        spec.category = "crypto_mining".into();
        assert!(matches!(
            evaluate_node_eligibility(&node, &spec),
            Err(FilterRejectionReason::CategoryNotAllowed { .. })
        ));
        node.policy.allowed_categories = vec![];
        spec.category = "general".into();

        // 14. Deadline infeasible (Sprint 4: GD-03)
        spec.deadline_ms = Some(100);
        assert!(matches!(
            evaluate_node_eligibility(&node, &spec),
            Err(FilterRejectionReason::DeadlineInfeasible { .. })
        ));
        spec.deadline_ms = None;

        // 15. Cost budget exceeded (Sprint 4: GD-04)
        spec.max_cost_credits = Some(5);
        assert!(matches!(
            evaluate_node_eligibility(&node, &spec),
            Err(FilterRejectionReason::CostExceedsMax { .. })
        ));
    }
}
