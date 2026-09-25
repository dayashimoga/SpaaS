use spaas_protocol::node::{NodeTelemetry, ProviderPolicy};
use tracing::warn;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum YieldReason {
    UserPaused,
    ThermalThresholdExceeded,
    BatteryTooLow,
    UnpluggedWhileChargingRequired,
    SwitchedToMeteredNetwork,
}

pub struct ResourceSafetyMonitor;

impl ResourceSafetyMonitor {
    /// Evaluates current telemetry against configured provider safety policy.
    /// Returns Some(YieldReason) if compute activity MUST immediately yield.
    pub fn check_safety_yield(
        telemetry: &NodeTelemetry,
        policy: &ProviderPolicy,
    ) -> Option<YieldReason> {
        if policy.is_user_paused {
            return Some(YieldReason::UserPaused);
        }

        if telemetry.thermal_status > policy.max_thermal_threshold {
            warn!(
                current_thermal = ?telemetry.thermal_status,
                threshold = ?policy.max_thermal_threshold,
                "Thermal threshold exceeded; yielding compute resources"
            );
            return Some(YieldReason::ThermalThresholdExceeded);
        }

        if telemetry.battery_pct < policy.min_battery_threshold_pct {
            warn!(
                battery = telemetry.battery_pct,
                min_threshold = policy.min_battery_threshold_pct,
                "Battery dropped below safety threshold; yielding compute resources"
            );
            return Some(YieldReason::BatteryTooLow);
        }

        if policy.only_while_charging && !telemetry.charging_state.is_charging() {
            warn!("Device unplugged; policy requires charging; yielding compute resources");
            return Some(YieldReason::UnpluggedWhileChargingRequired);
        }

        if policy.only_on_unmetered_network && !telemetry.network_type.is_unmetered() {
            warn!("Switched to metered cellular network; policy requires unmetered; yielding");
            return Some(YieldReason::SwitchedToMeteredNetwork);
        }

        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use spaas_protocol::node::{ChargingState, NetworkType, ThermalStatus};

    #[test]
    fn test_resource_safety_yield_reasons() {
        let mut policy = ProviderPolicy::default();
        let mut telemetry = NodeTelemetry::default();

        // 1. Normal state: no yield
        assert_eq!(ResourceSafetyMonitor::check_safety_yield(&telemetry, &policy), None);

        // 2. UserPaused
        policy.is_user_paused = true;
        assert_eq!(
            ResourceSafetyMonitor::check_safety_yield(&telemetry, &policy),
            Some(YieldReason::UserPaused)
        );
        policy.is_user_paused = false;

        // 3. ThermalThresholdExceeded
        policy.max_thermal_threshold = ThermalStatus::Moderate;
        telemetry.thermal_status = ThermalStatus::Severe;
        assert_eq!(
            ResourceSafetyMonitor::check_safety_yield(&telemetry, &policy),
            Some(YieldReason::ThermalThresholdExceeded)
        );
        telemetry.thermal_status = ThermalStatus::None;

        // 4. BatteryTooLow
        policy.min_battery_threshold_pct = 30;
        telemetry.battery_pct = 20;
        assert_eq!(
            ResourceSafetyMonitor::check_safety_yield(&telemetry, &policy),
            Some(YieldReason::BatteryTooLow)
        );
        telemetry.battery_pct = 80;

        // 5. UnpluggedWhileChargingRequired
        policy.only_while_charging = true;
        telemetry.charging_state = ChargingState::Discharging;
        assert_eq!(
            ResourceSafetyMonitor::check_safety_yield(&telemetry, &policy),
            Some(YieldReason::UnpluggedWhileChargingRequired)
        );
        telemetry.charging_state = ChargingState::ChargingAc;

        // 6. SwitchedToMeteredNetwork
        policy.only_on_unmetered_network = true;
        telemetry.network_type = NetworkType::CellularMetered;
        assert_eq!(
            ResourceSafetyMonitor::check_safety_yield(&telemetry, &policy),
            Some(YieldReason::SwitchedToMeteredNetwork)
        );
    }
}

