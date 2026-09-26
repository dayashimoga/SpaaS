use crate::filter::evaluate_node_eligibility;
use crate::policy::SchedulerConfig;
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
        let (selected, _decision) = self.schedule_workload_with_decision(spec, nodes)?;
        Ok(selected)
    }

    /// Evaluates all nodes with complete workload-dimension scoring and generates an auditable SchedulerDecision
    pub fn schedule_workload_with_decision(
        &self,
        spec: &WorkloadSpec,
        nodes: &[NodeRecord],
    ) -> Result<(Vec<Uuid>, spaas_protocol::workload::SchedulerDecision), ProtocolError> {
        use spaas_protocol::workload::{
            CandidateEvaluation, RejectedNodeEvaluation, SchedulerDecision,
        };

        let mut eligible_candidates: Vec<CandidateEvaluation> = Vec::new();
        let mut rejected_nodes: Vec<RejectedNodeEvaluation> = Vec::new();

        for node in nodes {
            match evaluate_node_eligibility(node, spec) {
                Ok(()) => {
                    let live = node.compute_live_capacity();
                    let (score, dimension_scores) =
                        crate::scorer::score_workload_fit(node, &spec.dimension_weights, &live);
                    let is_physical = !node.is_simulated
                        && (node.device_type
                            == spaas_protocol::node::NodeDeviceType::AndroidSmartphone
                            || node.device_type
                                == spaas_protocol::node::NodeDeviceType::LinuxDesktop
                            || node.device_type
                                == spaas_protocol::node::NodeDeviceType::WindowsDesktop
                            || node.device_type
                                == spaas_protocol::node::NodeDeviceType::MacDesktop);

                    eligible_candidates.push(CandidateEvaluation {
                        node_id: node.node_id,
                        device_model: node.capabilities.device_model.clone(),
                        device_type: format!("{:?}", node.device_type),
                        is_physical,
                        score,
                        rank: 0,
                        dimension_scores,
                        live_multiplier: live.capacity_multiplier,
                    });
                }
                Err(rejection) => {
                    rejected_nodes.push(RejectedNodeEvaluation {
                        node_id: node.node_id,
                        device_model: node.capabilities.device_model.clone(),
                        reason: rejection.description(),
                        failed_constraint: rejection.failed_constraint().into(),
                    });
                }
            }
        }

        // Sort candidates descending by fit score
        eligible_candidates.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        // Set 1-based ranks
        for (idx, candidate) in eligible_candidates.iter_mut().enumerate() {
            candidate.rank = idx + 1;
        }

        let required_nodes_count = match &spec.verification_policy {
            VerificationPolicy::None => 1,
            VerificationPolicy::SingleNode => 1,
            VerificationPolicy::HashMatch { .. } => 1,
            VerificationPolicy::MOfN { replicas, .. } => *replicas as usize,
            VerificationPolicy::DeterministicReplay => 2,
            VerificationPolicy::TrustedNode { min_reputation } => {
                eligible_candidates.retain(|c| {
                    if let Some(n) = nodes.iter().find(|node| node.node_id == c.node_id) {
                        (n.telemetry.reliability_score * 100.0) >= *min_reputation as f32
                    } else {
                        false
                    }
                });
                1
            }
            VerificationPolicy::CustomVerifier { .. } => 1,
            VerificationPolicy::SpotCheck { .. } => 1,
            VerificationPolicy::TeeAttested => 1,
        };

        if eligible_candidates.len() < required_nodes_count {
            debug!(
                workload_id = %spec.workload_id,
                eligible = eligible_candidates.len(),
                required = required_nodes_count,
                "No eligible nodes matched workload requirements"
            );
            let _decision = SchedulerDecision {
                job_id: spec.workload_id,
                workload_name: spec.name.clone(),
                selected_node_id: None,
                selected_node_model: None,
                eligible_candidate_count: eligible_candidates.len(),
                total_evaluated_nodes: nodes.len(),
                weights_used: spec.dimension_weights.clone(),
                top_candidates: eligible_candidates,
                rejected_nodes,
                decision_rationale: format!(
                    "Scheduling failed: 0 of {} evaluated nodes satisfied all required hardware capabilities and owner policies.",
                    nodes.len()
                ),
                decided_at_ms: chrono::Utc::now().timestamp_millis(),
            };
            return Err(ProtocolError::NoEligibleNodeFound);
        }

        let selected: Vec<Uuid> = eligible_candidates
            .iter()
            .take(required_nodes_count)
            .map(|c| c.node_id)
            .collect();

        let top_winner = &eligible_candidates[0];
        let rationale = format!(
            "Selected '{}' (Node ID: {}) with highest multidimensional fit score {:.2}. \
             Evaluated {} nodes ({} eligible, {} rejected). \
             Live capacity multiplier: {:.2}. Physical device: {}.",
            top_winner.device_model,
            top_winner.node_id,
            top_winner.score,
            nodes.len(),
            eligible_candidates.len(),
            rejected_nodes.len(),
            top_winner.live_multiplier,
            top_winner.is_physical
        );

        let decision = SchedulerDecision {
            job_id: spec.workload_id,
            workload_name: spec.name.clone(),
            selected_node_id: Some(top_winner.node_id),
            selected_node_model: Some(top_winner.device_model.clone()),
            eligible_candidate_count: eligible_candidates.len(),
            total_evaluated_nodes: nodes.len(),
            weights_used: spec.dimension_weights.clone(),
            top_candidates: eligible_candidates.into_iter().take(5).collect(),
            rejected_nodes,
            decision_rationale: rationale,
            decided_at_ms: chrono::Utc::now().timestamp_millis(),
        };

        info!(
            workload_id = %spec.workload_id,
            nodes_assigned = ?selected,
            "Workload scheduled with multidimensional fit decision"
        );

        Ok((selected, decision))
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
            dimension_weights: WorkloadDimensionWeights::default(),
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
                charging_state: ChargingState::ChargingUsb,
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

        assert_eq!(scheduler.config().max_queue_capacity, 10_000);

        // Test 1: Empty nodes list
        assert!(matches!(
            scheduler.schedule_workload(&spec, &[]),
            Err(ProtocolError::NoEligibleNodeFound)
        ));

        // Test 2: MOfN selection
        let mut m_of_n_spec = spec.clone();
        m_of_n_spec.verification_policy = VerificationPolicy::MOfN {
            replicas: 2,
            threshold: 2,
        };
        let m_selected = scheduler.schedule_workload(&m_of_n_spec, &nodes).unwrap();
        assert_eq!(m_selected.len(), 2);

        // Test 3: DeterministicReplay selection
        let mut replay_spec = spec.clone();
        replay_spec.verification_policy = VerificationPolicy::DeterministicReplay;
        let replay_selected = scheduler.schedule_workload(&replay_spec, &nodes).unwrap();
        assert_eq!(replay_selected.len(), 2);

        // Test 4: TrustedNode filtering
        let mut trusted_spec = spec.clone();
        trusted_spec.verification_policy = VerificationPolicy::TrustedNode { min_reputation: 90 };
        let mut low_nodes = nodes.clone();
        low_nodes[0].telemetry.reliability_score = 0.4;
        low_nodes[1].telemetry.reliability_score = 0.4;
        assert!(matches!(
            scheduler.schedule_workload(&trusted_spec, &low_nodes),
            Err(ProtocolError::NoEligibleNodeFound)
        ));

        // If at least one node has high reputation, scheduling succeeds
        low_nodes[0].telemetry.reliability_score = 0.95;
        let trusted_selected = scheduler
            .schedule_workload(&trusted_spec, &low_nodes)
            .unwrap();
        assert_eq!(trusted_selected, vec![low_nodes[0].node_id]);

        // Test other verification policies: None, HashMatch, CustomVerifier, SpotCheck, TeeAttested
        let mut policy_spec = spec.clone();
        policy_spec.verification_policy = VerificationPolicy::None;
        assert_eq!(
            scheduler
                .schedule_workload(&policy_spec, &nodes)
                .unwrap()
                .len(),
            1
        );

        policy_spec.verification_policy = VerificationPolicy::HashMatch {
            expected_digest: "hash".into(),
        };
        assert_eq!(
            scheduler
                .schedule_workload(&policy_spec, &nodes)
                .unwrap()
                .len(),
            1
        );

        policy_spec.verification_policy = VerificationPolicy::CustomVerifier {
            verifier_endpoint: "http://endpoint".into(),
        };
        assert_eq!(
            scheduler
                .schedule_workload(&policy_spec, &nodes)
                .unwrap()
                .len(),
            1
        );

        policy_spec.verification_policy = VerificationPolicy::SpotCheck {
            probability_pct: 10,
        };
        assert_eq!(
            scheduler
                .schedule_workload(&policy_spec, &nodes)
                .unwrap()
                .len(),
            1
        );

        policy_spec.verification_policy = VerificationPolicy::TeeAttested;
        assert_eq!(
            scheduler
                .schedule_workload(&policy_spec, &nodes)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn test_scheduler_workload_fit_decision_and_rejection_tracking() {
        let scheduler = EdgeScheduler::new(SchedulerConfig::default());

        let spec = WorkloadSpec {
            name: "sha256_audit".into(),
            dimension_weights: WorkloadDimensionWeights::for_sha256(),
            ..Default::default()
        };

        let eligible_node = NodeRecord {
            node_id: Uuid::new_v4(),
            public_key: "pub_el".into(),
            device_type: NodeDeviceType::AndroidSmartphone,
            enrollment: EnrollmentStatus::Enrolled,
            state: NodeState::Idle,
            capabilities: NodeHardwareCapabilities {
                device_model: "Pixel 8 Physical".into(),
                ..Default::default()
            },
            telemetry: NodeTelemetry {
                battery_pct: 95,
                charging_state: ChargingState::ChargingAc,
                thermal_status: ThermalStatus::None,
                ..Default::default()
            },
            policy: ProviderPolicy::default(),
            qualification: Some(NodeQualificationProfile {
                benchmark_version: "v1.2.0".into(),
                qualified_at_ms: 1000,
                runtime_environment: "Test Sandbox".into(),
                wasm_conformance_passed: true,
                wasi_preview1_passed: true,
                measured_fuel_mips: 450.0,
                measured_memory_max_pages: 512,
                raw_metrics: RawBenchmarkMetrics::default(),
                capability_vector: CapabilityVector {
                    cpu: 90,
                    wasm: 95,
                    ..Default::default()
                },
                edge_score: 92,
                tier: QualificationTier::Qualified,
                qualification_hash: "hash".into(),
                qualification_signature: "sig".into(),
            }),
            enrolled_at_ms: 0,
            last_heartbeat_ms: 0,
            region: "local".into(),
            is_simulated: false,
        };

        let rejected_node = NodeRecord {
            node_id: Uuid::new_v4(),
            public_key: "pub_rej".into(),
            device_type: NodeDeviceType::SimulatedNode,
            enrollment: EnrollmentStatus::Enrolled,
            state: NodeState::Idle,
            capabilities: NodeHardwareCapabilities {
                device_model: "Cold Dead Phone".into(),
                ..Default::default()
            },
            telemetry: NodeTelemetry {
                battery_pct: 10, // below 40 min threshold
                charging_state: ChargingState::Discharging,
                ..Default::default()
            },
            policy: ProviderPolicy::default(),
            qualification: None,
            enrolled_at_ms: 0,
            last_heartbeat_ms: 0,
            region: "local".into(),
            is_simulated: true,
        };

        let nodes = vec![eligible_node.clone(), rejected_node.clone()];
        let (selected, decision) = scheduler
            .schedule_workload_with_decision(&spec, &nodes)
            .expect("scheduling must succeed");

        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0], eligible_node.node_id);
        assert_eq!(decision.selected_node_id, Some(eligible_node.node_id));
        assert_eq!(
            decision.selected_node_model,
            Some("Pixel 8 Physical".into())
        );
        assert_eq!(decision.eligible_candidate_count, 1);
        assert_eq!(decision.rejected_nodes.len(), 1);
        assert_eq!(decision.rejected_nodes[0].node_id, rejected_node.node_id);
        assert!(decision.decision_rationale.contains("Pixel 8 Physical"));
        assert!(decision
            .decision_rationale
            .contains("multidimensional fit score"));
    }
}
