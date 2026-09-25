use crate::archetypes::{generate_device_profile, SimulatorArchetype};
use indicatif::{ProgressBar, ProgressStyle};
use spaas_node_agent::NodeAgent;
use spaas_protocol::rpc::*;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tracing::{error, info, warn};

pub struct SimulatorCluster {
    pub control_plane_url: String,
    pub agents: Vec<Arc<RwLock<NodeAgent>>>,
    pub adversarial_flags: Vec<bool>,
    pub drop_rates: Vec<u8>,
}

impl SimulatorCluster {
    pub fn new(control_plane_url: String, node_count: usize, adversarial_ratio: f64) -> Self {
        let mut agents = Vec::with_capacity(node_count);
        let mut adversarial_flags = Vec::with_capacity(node_count);
        let mut drop_rates = Vec::with_capacity(node_count);

        for i in 0..node_count {
            let is_adv = (i as f64 / node_count as f64) < adversarial_ratio;
            let archetype = if is_adv {
                SimulatorArchetype::AdversarialNode
            } else {
                match i % 6 {
                    0 => SimulatorArchetype::FlagshipAcCharging,
                    1 => SimulatorArchetype::MidrangeWifi,
                    2 => SimulatorArchetype::BudgetCellular,
                    3 => SimulatorArchetype::OverheatingPhone,
                    4 => SimulatorArchetype::LowBatteryPhone,
                    _ => SimulatorArchetype::FlakyDisconnecting,
                }
            };

            let profile = generate_device_profile(archetype, i + 1);
            let mut agent = NodeAgent::new(profile.capabilities, profile.policy, true);
            agent.telemetry = profile.initial_telemetry;

            agents.push(Arc::new(RwLock::new(agent)));
            adversarial_flags.push(profile.is_adversarial);
            drop_rates.push(profile.drop_probability_pct);
        }

        Self {
            control_plane_url,
            agents,
            adversarial_flags,
            drop_rates,
        }
    }

    /// Enrolls and registers all simulated nodes with the Control Plane
    pub async fn register_all(&self) -> Result<usize, String> {
        let client = reqwest::Client::new();
        let pb = ProgressBar::new(self.agents.len() as u64);
        pb.set_style(
            ProgressStyle::default_bar()
                .template("{spinner:.green} [{elapsed_precise}] [{bar:40.cyan/blue}] {pos}/{len} nodes registered ({eta})")
                .unwrap(),
        );

        let mut success_count = 0;

        for (idx, agent_lock) in self.agents.iter().enumerate() {
            let agent = agent_lock.read().await;
            let req = RegisterNodeRequest {
                public_key: agent.public_key_hex(),
                device_type: spaas_protocol::node::NodeDeviceType::SimulatedNode,
                capabilities: agent.capabilities.clone(),
                initial_telemetry: agent.telemetry.clone(),
                initial_policy: agent.policy.clone(),
                region: format!("sim-zone-{}", idx % 4),
                is_simulated: true,
                enrollment_signature: format!("sim_sig_{idx}"),
                timestamp_ms: chrono::Utc::now().timestamp_millis(),
            };

            let url = format!("{}/api/v1/nodes/register", self.control_plane_url);
            match client.post(&url).json(&req).send().await {
                Ok(resp) if resp.status().is_success() => {
                    success_count += 1;
                }
                Ok(resp) => {
                    warn!("Failed to register node {}: HTTP {}", idx, resp.status());
                }
                Err(e) => {
                    error!("Connection error registering node {}: {}", idx, e);
                }
            }
            pb.inc(1);
        }
        pb.finish_with_message("Registration complete");
        Ok(success_count)
    }

    /// Runs periodic heartbeats and job dispatch listeners for all nodes
    pub async fn run_simulation_loop(&self, duration: Duration) {
        info!("Starting simulation loop for {} nodes...", self.agents.len());
        let start_time = tokio::time::Instant::now();
        let client = reqwest::Client::new();

        while start_time.elapsed() < duration {
            for (idx, agent_lock) in self.agents.iter().enumerate() {
                let mut agent = agent_lock.write().await;
                let is_adversarial = self.adversarial_flags[idx];
                let drop_rate = self.drop_rates[idx];

                // Flaky dropout simulation
                if drop_rate > 0 && (rand::random::<u8>() % 100) < drop_rate {
                    warn!(node_id = %agent.node_id, "Simulated node dropped connection!");
                    continue;
                }

                // Heartbeat
                let hb_req = HeartbeatRequest {
                    node_id: agent.node_id,
                    telemetry: agent.telemetry.clone(),
                    policy: agent.policy.clone(),
                    timestamp_ms: chrono::Utc::now().timestamp_millis(),
                    signature: "sim_hb_sig".into(),
                };

                let hb_url = format!("{}/api/v1/nodes/heartbeat", self.control_plane_url);
                let _ = client.post(&hb_url).json(&hb_req).send().await;

                // Poll for work
                let poll_url = format!("{}/api/v1/nodes/{}/poll", self.control_plane_url, agent.node_id);
                if let Ok(resp) = client.get(&poll_url).send().await {
                    if let Ok(poll_res) = resp.json::<PollJobResponse>().await {
                        if let Some(dispatch) = poll_res.job {
                            info!(node_id = %agent.node_id, job_id = %dispatch.job_id, "Simulated node received job dispatch");

                            let exec_result = agent.execute_dispatched_job(dispatch).await;
                            if let Ok(mut job_result) = exec_result {
                                if is_adversarial {
                                    // Tamper with the result to trigger Byzantine detection
                                    warn!(node_id = %agent.node_id, "Adversarial node corrupting result digest!");
                                    job_result.result_digest = "corrupted_malicious_digest".into();
                                }

                                let res_url = format!("{}/api/v1/nodes/results", self.control_plane_url);
                                let submit_req = SubmitJobResultRequest {
                                    node_id: agent.node_id,
                                    result: job_result,
                                };
                                let _ = client.post(&res_url).json(&submit_req).send().await;
                            }
                        }
                    }
                }
            }

            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
}
