use crate::policy::SchedulerWeights;
use spaas_protocol::node::{ChargingState, NetworkType, NodeRecord, ThermalStatus};

/// Calculates a normalized scalar score (0.0 to 100.0+) for an eligible candidate node
pub fn score_node(node: &NodeRecord, weights: &SchedulerWeights) -> f64 {
    // 1. Charging status (0.0 or 100.0)
    let charging_score = match node.telemetry.charging_state {
        ChargingState::ChargingAc | ChargingState::ChargingWireless | ChargingState::Full => 100.0,
        ChargingState::ChargingUsb => 75.0,
        _ => 20.0,
    };

    // 2. Battery state of charge (0.0 - 100.0)
    let battery_score = (node.telemetry.battery_pct as f64).clamp(0.0, 100.0);

    // 3. Thermal headroom
    let thermal_score = match node.telemetry.thermal_status {
        ThermalStatus::None => 100.0,
        ThermalStatus::Light => 80.0,
        ThermalStatus::Moderate => 40.0,
        ThermalStatus::Severe => 10.0,
        _ => 0.0,
    };

    // 4. Network quality
    let network_score = match node.telemetry.network_type {
        NetworkType::Ethernet => 100.0,
        NetworkType::WifiUnmetered => 90.0,
        NetworkType::CellularMetered => 30.0,
        NetworkType::Vpn => 50.0,
        _ => 10.0,
    };

    // 5. Historical reliability
    let reliability_score = (node.telemetry.reliability_score as f64 * 100.0).clamp(0.0, 100.0);

    // 6. Ping latency
    let ping = node.telemetry.round_trip_ping_ms.unwrap_or(80) as f64;
    let latency_score = (100.0 - ping).clamp(0.0, 100.0);

    // 7. Current CPU load penalty
    let load_penalty = (node.telemetry.cpu_usage_pct as f64).clamp(0.0, 100.0);

    let composite_score = (charging_score * weights.charging_weight)
        + (battery_score * weights.battery_weight)
        + (thermal_score * weights.thermal_weight)
        + (network_score * weights.network_weight)
        + (reliability_score * weights.reliability_weight)
        + (latency_score * weights.latency_weight)
        - (load_penalty * weights.load_penalty_weight);

    composite_score.max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use spaas_protocol::node::*;
    use uuid::Uuid;

    #[test]
    fn test_node_scoring_preferences() {
        let weights = SchedulerWeights::default();

        let node_excellent = NodeRecord {
            node_id: Uuid::new_v4(),
            public_key: "k1".into(),
            device_type: NodeDeviceType::AndroidSmartphone,
            enrollment: EnrollmentStatus::Enrolled,
            state: NodeState::Idle,
            capabilities: NodeHardwareCapabilities::default(),
            telemetry: NodeTelemetry {
                battery_pct: 95,
                charging_state: ChargingState::ChargingAc,
                thermal_status: ThermalStatus::None,
                network_type: NetworkType::WifiUnmetered,
                reliability_score: 1.0,
                cpu_usage_pct: 2.0,
                round_trip_ping_ms: Some(15),
                ..Default::default()
            },
            policy: ProviderPolicy::default(),
            enrolled_at_ms: 0,
            last_heartbeat_ms: 0,
            region: "us".into(),
            is_simulated: false,
        };

        let mut node_mediocre = node_excellent.clone();
        node_mediocre.node_id = Uuid::new_v4();
        node_mediocre.telemetry.battery_pct = 45;
        node_mediocre.telemetry.charging_state = ChargingState::Discharging;
        node_mediocre.telemetry.thermal_status = ThermalStatus::Moderate;
        node_mediocre.telemetry.network_type = NetworkType::CellularMetered;
        node_mediocre.telemetry.reliability_score = 0.7;
        node_mediocre.telemetry.cpu_usage_pct = 65.0;

        let score_exc = score_node(&node_excellent, &weights);
        let score_med = score_node(&node_mediocre, &weights);

        assert!(score_exc > score_med, "Excellent node must outscore mediocre node");
        assert!(score_exc >= 80.0);
    }
}
