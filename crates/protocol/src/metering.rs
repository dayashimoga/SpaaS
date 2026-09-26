use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceUsage {
    /// WebAssembly fuel consumed during execution
    pub fuel_consumed: u64,
    /// Wall clock duration in milliseconds
    pub wall_time_ms: u64,
    /// Peak RAM allocated in bytes
    pub memory_peak_bytes: u64,
    /// Inbound bytes (workload download + inputs)
    pub network_ingress_bytes: u64,
    /// Outbound bytes (results + telemetry)
    pub network_egress_bytes: u64,
    /// Ephemeral storage bytes utilized
    pub storage_bytes: u64,
}

impl ResourceUsage {
    /// Computes platform Compute Credits (verifiable internal accounting)
    /// 1 Credit = 100,000 Fuel + 1MB*sec memory + 100KB bandwidth
    pub fn calculate_credits(&self) -> u64 {
        let fuel_credits = self.fuel_consumed / 100_000;
        let memory_mb_sec = (self.memory_peak_bytes / (1024 * 1024)) * (self.wall_time_ms / 1000);
        let bandwidth_credits =
            (self.network_ingress_bytes + self.network_egress_bytes) / (100 * 1024);

        // Minimum charge of 1 credit for any completed execution
        (fuel_credits + memory_mb_sec + bandwidth_credits).max(1)
    }

    /// Computes detailed deterministic Test Credit breakdown with transparent formula components
    pub fn breakdown(&self, idempotency_key: &str) -> MeteringBreakdown {
        let fuel_credits = self.fuel_consumed / 100_000;
        let memory_mb_sec = (self.memory_peak_bytes / (1024 * 1024)) * (self.wall_time_ms / 1000);
        let bandwidth_credits =
            (self.network_ingress_bytes + self.network_egress_bytes) / (100 * 1024);
        let base_credits = 1;
        let total = (base_credits + fuel_credits + memory_mb_sec + bandwidth_credits).max(1);
        let provider_share = (total * 95) / 100;
        let protocol_reserve = total - provider_share;

        MeteringBreakdown {
            base_credits,
            fuel_credits,
            memory_credits: memory_mb_sec,
            bandwidth_credits,
            total_test_credits: total,
            provider_share: provider_share.max(1),
            protocol_reserve,
            formula_description: "Base(1) + Fuel(1/100k) + RAM*Duration(MB*s) + Bandwidth(1/100KB) [TEST CREDITS ONLY - No Fiat/INR/USD Equivalence]".into(),
            idempotency_key: idempotency_key.to_string(),
        }
    }
}

/// Detailed transparent breakdown of Test Credits
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeteringBreakdown {
    pub base_credits: u64,
    pub fuel_credits: u64,
    pub memory_credits: u64,
    pub bandwidth_credits: u64,
    pub total_test_credits: u64,
    pub provider_share: u64,
    pub protocol_reserve: u64,
    pub formula_description: String,
    pub idempotency_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MeteringRecord {
    pub record_id: Uuid,
    /// Strictly unique idempotency key: hash of job_id and result_id to prevent duplicate billing
    pub idempotency_key: String,
    pub job_id: Uuid,
    pub node_id: Uuid,
    pub provider_public_key: String,
    pub submitter_public_key: String,
    pub usage: ResourceUsage,
    pub credits_earned_by_node: u64,
    pub credits_debited_from_submitter: u64,
    pub is_verified: bool,
    pub recorded_at_ms: i64,
}

impl MeteringRecord {
    pub fn create(
        job_id: Uuid,
        node_id: Uuid,
        result_digest: &str,
        provider_pubkey: String,
        submitter_pubkey: String,
        usage: ResourceUsage,
        is_verified: bool,
    ) -> Self {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(job_id.as_bytes());
        hasher.update(node_id.as_bytes());
        hasher.update(result_digest.as_bytes());
        let idempotency_key = hex::encode(hasher.finalize());

        let credits = if is_verified {
            usage.calculate_credits()
        } else {
            0
        };

        Self {
            record_id: Uuid::new_v4(),
            idempotency_key,
            job_id,
            node_id,
            provider_public_key: provider_pubkey,
            submitter_public_key: submitter_pubkey,
            usage,
            credits_earned_by_node: credits,
            credits_debited_from_submitter: credits,
            is_verified,
            recorded_at_ms: chrono::Utc::now().timestamp_millis(),
        }
    }
}

/// Ledger account summary
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct AccountLedger {
    pub public_key: String,
    pub balance_credits: i64,
    pub total_earned: u64,
    pub total_spent: u64,
    pub total_jobs_executed: u64,
    pub total_jobs_submitted: u64,
    pub updated_at_ms: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_metering_calculation_and_idempotency() {
        let usage = ResourceUsage {
            fuel_consumed: 1_000_000, // 10 credits
            wall_time_ms: 2000,
            memory_peak_bytes: 32 * 1024 * 1024, // 32MB * 2s = 64 credits
            network_ingress_bytes: 200 * 1024,   // 2 credits
            network_egress_bytes: 100 * 1024,    // 1 credit
            storage_bytes: 1024,
        };

        let credits = usage.calculate_credits();
        assert_eq!(credits, 10 + 64 + 3);

        let job_id = Uuid::new_v4();
        let node_id = Uuid::new_v4();
        let rec1 = MeteringRecord::create(
            job_id,
            node_id,
            "digest123",
            "prov_pub".into(),
            "sub_pub".into(),
            usage.clone(),
            true,
        );
        let rec2 = MeteringRecord::create(
            job_id,
            node_id,
            "digest123",
            "prov_pub".into(),
            "sub_pub".into(),
            usage,
            true,
        );

        // Idempotency keys must be strictly identical for the same job, node and digest
        assert_eq!(rec1.idempotency_key, rec2.idempotency_key);
        assert_eq!(rec1.credits_earned_by_node, 77);
    }
}
