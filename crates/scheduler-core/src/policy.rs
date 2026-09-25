use serde::{Deserialize, Serialize};

/// Configurable weights for intelligent node scheduling per Section 5
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchedulerWeights {
    /// Importance of node plugged into AC/wireless power (0.0 - 1.0)
    pub charging_weight: f64,
    /// Importance of high battery state of charge (0.0 - 1.0)
    pub battery_weight: f64,
    /// Importance of low thermal status (0.0 - 1.0)
    pub thermal_weight: f64,
    /// Importance of unmetered network connection (0.0 - 1.0)
    pub network_weight: f64,
    /// Importance of historical reliability / success score (0.0 - 1.0)
    pub reliability_weight: f64,
    /// Penalty for high current CPU and job load (0.0 - 1.0)
    pub load_penalty_weight: f64,
    /// Bonus for lower ping latency (0.0 - 1.0)
    pub latency_weight: f64,
}

impl Default for SchedulerWeights {
    fn default() -> Self {
        Self {
            charging_weight: 0.25,
            battery_weight: 0.15,
            thermal_weight: 0.20,
            network_weight: 0.15,
            reliability_weight: 0.15,
            load_penalty_weight: 0.05,
            latency_weight: 0.05,
        }
    }
}

/// Overall scheduler configuration
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchedulerConfig {
    pub weights: SchedulerWeights,
    /// Maximum jobs allowed in queue before triggering backpressure rejection
    pub max_queue_capacity: usize,
    /// Maximum concurrent jobs per node unless specified by node policy
    pub default_max_concurrent_jobs: u32,
    /// Disconnect timeout: mark node offline if no heartbeat within this duration
    pub node_offline_timeout_secs: u64,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            weights: SchedulerWeights::default(),
            max_queue_capacity: 10_000,
            default_max_concurrent_jobs: 1,
            node_offline_timeout_secs: 30,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scheduler_config_serde() {
        let cfg = SchedulerConfig::default();
        let json = serde_json::to_string(&cfg).unwrap();
        let deser: SchedulerConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(cfg, deser);
        assert_eq!(deser.max_queue_capacity, 10_000);
    }
}
