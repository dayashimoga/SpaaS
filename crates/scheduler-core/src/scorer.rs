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

/// Workload-specific multi-attribute fit scoring using CapabilityVector and LiveCapacity
pub fn score_workload_fit(
    node: &NodeRecord,
    weights: &spaas_protocol::workload::WorkloadDimensionWeights,
    live: &spaas_protocol::node::LiveCapacity,
) -> (f64, std::collections::HashMap<String, f64>) {
    use spaas_protocol::node::{CapabilityStatus, CapabilityVector};
    let mut dimension_scores = std::collections::HashMap::new();

    let caps = match &node.qualification {
        Some(q) => q.capability_vector.clone(),
        None => CapabilityVector::default(),
    };

    let cpu_score = caps.cpu as f64 * weights.cpu;
    dimension_scores.insert("cpu".into(), cpu_score);

    let wasm_score = caps.wasm as f64 * weights.wasm;
    dimension_scores.insert("wasm".into(), wasm_score);

    let fp_score = caps.fp as f64 * weights.fp;
    dimension_scores.insert("fp".into(), fp_score);

    let memory_score = caps.memory as f64 * weights.memory;
    dimension_scores.insert("memory".into(), memory_score);

    let gpu_score = match caps.gpu {
        CapabilityStatus::Score(s) => s as f64 * weights.gpu,
        _ => 0.0,
    };
    dimension_scores.insert("gpu".into(), gpu_score);

    let npu_score = match caps.npu {
        CapabilityStatus::Score(s) => s as f64 * weights.npu,
        _ => 0.0,
    };
    dimension_scores.insert("npu".into(), npu_score);

    let storage_score = caps.storage as f64 * weights.storage;
    dimension_scores.insert("storage".into(), storage_score);

    let network_score = caps.network as f64 * weights.network;
    dimension_scores.insert("network".into(), network_score);

    let reliability_score = caps.reliability as f64 * weights.reliability;
    dimension_scores.insert("reliability".into(), reliability_score);

    let energy_score = caps.energy_efficiency as f64 * weights.energy_efficiency;
    dimension_scores.insert("energy_efficiency".into(), energy_score);

    let base_sum: f64 = dimension_scores.values().sum();

    // Multiply by dynamic live capacity multiplier (0.0 to 1.0)
    let composite_score = base_sum * (live.capacity_multiplier as f64);

    (composite_score, dimension_scores)
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
            qualification: None,
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

        assert!(
            score_exc > score_med,
            "Excellent node must outscore mediocre node"
        );
        assert!(score_exc >= 80.0);

        // Test other charging, thermal, and network variants
        let mut variant_node = node_excellent.clone();
        variant_node.telemetry.charging_state = ChargingState::ChargingUsb;
        variant_node.telemetry.thermal_status = ThermalStatus::Light;
        variant_node.telemetry.network_type = NetworkType::Ethernet;
        let score_var1 = score_node(&variant_node, &weights);
        assert!(score_var1 > 0.0);

        variant_node.telemetry.charging_state = ChargingState::NotCharging;
        variant_node.telemetry.thermal_status = ThermalStatus::Severe;
        variant_node.telemetry.network_type = NetworkType::Vpn;
        let score_var2 = score_node(&variant_node, &weights);
        assert!(score_var2 < score_var1);

        variant_node.telemetry.thermal_status = ThermalStatus::Critical;
        variant_node.telemetry.network_type = NetworkType::Unknown;
        let score_var3 = score_node(&variant_node, &weights);
        assert!(score_var3 <= score_var2);
    }
}
