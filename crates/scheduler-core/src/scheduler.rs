use crate::filter::evaluate_node_eligibility;
use crate::policy::SchedulerConfig;
use crate::scorer::score_node;
use spaas_protocol::error::ProtocolError;
use spaas_protocol::node::NodeRecord;
use spaas_protocol::workload::{VerificationPolicy, WorkloadSpec};
use tracing::{debug, info};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct ScoredCandidate {
    pub node_id: Uuid,
    pub score: f64,
    pub reliability_score: f32,
}

pub struct EdgeScheduler {
    config: SchedulerConfig,
}

impl EdgeScheduler {
    pub fn new(config: SchedulerConfig) -> Self {
        Self { config }
    }

    pub fn config(&self) -> &SchedulerConfig {
        &self.config
    }

    /// Evaluates all available registered nodes, filters out ineligible candidates,
    /// scores the remainder, and selects the optimal node(s) for dispatch.
    pub fn schedule_workload(
        &self,
        spec: &WorkloadSpec,
        nodes: &[NodeRecord],
    ) -> Result<Vec<Uuid>, ProtocolError> {
        let mut candidates: Vec<ScoredCandidate> = Vec::new();

        for node in nodes {
            if evaluate_node_eligibility(node, spec).is_ok() {
                let score = score_node(node, &self.config.weights);
                candidates.push(ScoredCandidate {
                    node_id: node.node_id,
                    score,
                    reliability_score: node.telemetry.reliability_score,
                });
            }
        }

        if candidates.is_empty() {
            debug!(workload_id = %spec.workload_id, "No eligible nodes matched workload requirements");
            return Err(ProtocolError::NoEligibleNodeFound);
        }

        // Sort descending by score
        candidates.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

        // Determine how many nodes are needed based on verification policy
        let required_nodes_count = match &spec.verification_policy {
            VerificationPolicy::None => 1,
            VerificationPolicy::SingleNode => 1,
            VerificationPolicy::HashMatch { .. } => 1,
            VerificationPolicy::MOfN { replicas, .. } => *replicas as usize,
            VerificationPolicy::DeterministicReplay => 2,
            VerificationPolicy::TrustedNode { min_reputation } => {
                candidates.retain(|c| (c.reliability_score * 100.0) >= *min_reputation as f32);
                1
            }
            VerificationPolicy::CustomVerifier { .. } => 1,
            VerificationPolicy::SpotCheck { .. } => 1,
            VerificationPolicy::TeeAttested => 1,
        };

        if candidates.len() < required_nodes_count {
            return Err(ProtocolError::NoEligibleNodeFound);
        }

        let selected: Vec<Uuid> = candidates
            .into_iter()
            .take(required_nodes_count)
            .map(|c| c.node_id)
            .collect();

        info!(
            workload_id = %spec.workload_id,
            nodes_assigned = ?selected,
            "Workload scheduled successfully"
        );

        Ok(selected)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use spaas_protocol::node::*;
    use spaas_protocol::workload::*;

    #[test]
    fn test_edge_scheduler_selection() {
        let scheduler = EdgeScheduler::new(SchedulerConfig::default());
        let spec = WorkloadSpec {
            workload_id: Uuid::new_v4(),
            spec_version: "1.0.0".into(),
            name: "test".into(),
            runtime: RuntimeType::WasmWasi,
            artifact_sha256: "hash".into(),
            artifact_size_bytes: 100,
            artifact_uri: "uri".into(),
            entrypoint: "_start".into(),
            args: vec![],
            env_vars: vec![],
            limits: ResourceLimits::default(),
            network_policy: NetworkPolicy::None,
            required_capabilities: RequiredCapabilities::default(),
            retry_policy: RetryPolicy::default(),
            verification_policy: VerificationPolicy::SingleNode,
            priority: WorkloadPriority::Normal,
            submitter_signature: "sig".into(),
            submitter_pubkey: "pub".into(),
            created_at_ms: 1000,
        };

        let node1 = NodeRecord {
            node_id: Uuid::new_v4(),
            public_key: "k1".into(),
            device_type: NodeDeviceType::AndroidSmartphone,
            enrollment: EnrollmentStatus::Enrolled,
            state: NodeState::Idle,
            capabilities: NodeHardwareCapabilities::default(),
            telemetry: NodeTelemetry {
                battery_pct: 90,
                charging_state: ChargingState::ChargingAc,
                thermal_status: ThermalStatus::None,
                ..Default::default()
            },
            policy: ProviderPolicy::default(),
            qualification: None,
            enrolled_at_ms: 0,
            last_heartbeat_ms: 0,
            region: "us".into(),
            is_simulated: false,
        };

        let node2 = NodeRecord {
            node_id: Uuid::new_v4(),
            public_key: "k2".into(),
            device_type: NodeDeviceType::AndroidSmartphone,
            enrollment: EnrollmentStatus::Enrolled,
            state: NodeState::Idle,
            capabilities: NodeHardwareCapabilities::default(),
            telemetry: NodeTelemetry {
                battery_pct: 45,
                charging_state: ChargingState::Discharging,
                thermal_status: ThermalStatus::Moderate,
                ..Default::default()
            },
            policy: ProviderPolicy::default(),
            qualification: None,
            enrolled_at_ms: 0,
            last_heartbeat_ms: 0,
            region: "us".into(),
            is_simulated: false,
        };

        let nodes = vec![node1.clone(), node2.clone()];
        let selected = scheduler.schedule_workload(&spec, &nodes).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0], node1.node_id);
    }
}
