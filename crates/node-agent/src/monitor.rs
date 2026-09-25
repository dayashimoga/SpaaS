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
