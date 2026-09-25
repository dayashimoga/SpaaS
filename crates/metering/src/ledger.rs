use spaas_protocol::error::ProtocolError;
use spaas_protocol::metering::{AccountLedger, MeteringRecord, ResourceUsage};
use std::collections::HashMap;
use tracing::{info, warn};
use uuid::Uuid;

pub struct MeteringLedger {
    records_by_idempotency_key: HashMap<String, MeteringRecord>,
    accounts_by_pubkey: HashMap<String, AccountLedger>,
}

impl MeteringLedger {
    pub fn new() -> Self {
        Self {
            records_by_idempotency_key: HashMap::new(),
            accounts_by_pubkey: HashMap::new(),
        }
    }

    /// Deposits credits into an account (e.g. initial testing balance or developer top-up)
    pub fn deposit_credits(&mut self, pubkey: &str, amount: u64) {
        let account = self
            .accounts_by_pubkey
            .entry(pubkey.to_string())
            .or_insert_with(|| AccountLedger {
                public_key: pubkey.to_string(),
                balance_credits: 0,
                total_earned: 0,
                total_spent: 0,
                total_jobs_executed: 0,
                total_jobs_submitted: 0,
                updated_at_ms: chrono::Utc::now().timestamp_millis(),
            });

        account.balance_credits += amount as i64;
        account.updated_at_ms = chrono::Utc::now().timestamp_millis();
        info!(public_key = pubkey, amount, balance = account.balance_credits, "Account balance topped up");
    }

    /// Returns account summary for a public key
    pub fn get_account(&self, pubkey: &str) -> Option<&AccountLedger> {
        self.accounts_by_pubkey.get(pubkey)
    }

    /// Records job usage with strict idempotency and dual-entry accounting
    pub fn record_job_execution(
        &mut self,
        job_id: Uuid,
        node_id: Uuid,
        result_digest: &str,
        provider_pubkey: &str,
        submitter_pubkey: &str,
        usage: ResourceUsage,
        is_verified: bool,
    ) -> Result<MeteringRecord, ProtocolError> {
        let temp_record = MeteringRecord::create(
            job_id,
            node_id,
            result_digest,
            provider_pubkey.to_string(),
            submitter_pubkey.to_string(),
            usage,
            is_verified,
        );

        // 1. Idempotency Check: if identical job execution already processed, return cached record
        if let Some(existing) = self.records_by_idempotency_key.get(&temp_record.idempotency_key) {
            warn!(
                idempotency_key = %temp_record.idempotency_key,
                job_id = %job_id,
                "Duplicate metering event detected; skipping duplicate billing"
            );
            return Ok(existing.clone());
        }

        let credits = temp_record.credits_earned_by_node;

        // 2. Credit the node provider account
        let provider_acc = self
            .accounts_by_pubkey
            .entry(provider_pubkey.to_string())
            .or_insert_with(|| AccountLedger {
                public_key: provider_pubkey.to_string(),
                balance_credits: 0,
                total_earned: 0,
                total_spent: 0,
                total_jobs_executed: 0,
                total_jobs_submitted: 0,
                updated_at_ms: chrono::Utc::now().timestamp_millis(),
            });
        provider_acc.balance_credits += credits as i64;
        provider_acc.total_earned += credits;
        provider_acc.total_jobs_executed += 1;
        provider_acc.updated_at_ms = chrono::Utc::now().timestamp_millis();

        // 3. Debit the submitter account
        let submitter_acc = self
            .accounts_by_pubkey
            .entry(submitter_pubkey.to_string())
            .or_insert_with(|| AccountLedger {
                public_key: submitter_pubkey.to_string(),
                balance_credits: 10_000, // Developer seed balance
                total_earned: 0,
                total_spent: 0,
                total_jobs_executed: 0,
                total_jobs_submitted: 0,
                updated_at_ms: chrono::Utc::now().timestamp_millis(),
            });
        submitter_acc.balance_credits -= credits as i64;
        submitter_acc.total_spent += credits;
        submitter_acc.total_jobs_submitted += 1;
        submitter_acc.updated_at_ms = chrono::Utc::now().timestamp_millis();

        // 4. Save immutable record
        self.records_by_idempotency_key
            .insert(temp_record.idempotency_key.clone(), temp_record.clone());

        info!(
            job_id = %job_id,
            credits,
            provider = provider_pubkey,
            submitter = submitter_pubkey,
            "Metering record logged and credits transferred"
        );

        Ok(temp_record)
    }

    /// Returns all metering records for auditing
    pub fn all_records(&self) -> Vec<MeteringRecord> {
        self.records_by_idempotency_key.values().cloned().collect()
    }

    /// Returns all provider and consumer accounts
    pub fn all_accounts(&self) -> Vec<&AccountLedger> {
        self.accounts_by_pubkey.values().collect()
    }
}

impl Default for MeteringLedger {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_idempotent_metering_prevents_double_billing() {
        let mut ledger = MeteringLedger::new();
        let job_id = Uuid::new_v4();
        let node_id = Uuid::new_v4();
        let usage = ResourceUsage {
            fuel_consumed: 500_000,
            wall_time_ms: 1000,
            memory_peak_bytes: 10 * 1024 * 1024,
            network_ingress_bytes: 1024,
            network_egress_bytes: 1024,
            storage_bytes: 0,
        };

        let rec1 = ledger
            .record_job_execution(
                job_id,
                node_id,
                "digest_xyz",
                "node_provider_key",
                "submitter_key",
                usage.clone(),
                true,
            )
            .unwrap();

        let initial_provider_balance = ledger.get_account("node_provider_key").unwrap().balance_credits;
        assert_eq!(rec1.credits_earned_by_node, 15);
        assert_eq!(initial_provider_balance, 15);

        // Re-deliver same execution (e.g. network retry)
        let rec2 = ledger
            .record_job_execution(
                job_id,
                node_id,
                "digest_xyz",
                "node_provider_key",
                "submitter_key",
                usage.clone(),
                true,
            )
            .unwrap();

        assert_eq!(rec1.idempotency_key, rec2.idempotency_key);
        // Balance must remain unchanged due to idempotency protection
        let second_provider_balance = ledger.get_account("node_provider_key").unwrap().balance_credits;
        assert_eq!(second_provider_balance, initial_provider_balance);
        assert_eq!(ledger.get_account("node_provider_key").unwrap().total_jobs_executed, 1);

        // all_records and all_accounts
        assert_eq!(ledger.all_records().len(), 1);
        assert_eq!(ledger.all_accounts().len(), 2);

        // Unverified execution should award 0 credits
        let unverified_rec = ledger
            .record_job_execution(
                Uuid::new_v4(),
                node_id,
                "digest_unverified",
                "node_provider_key",
                "submitter_key",
                usage,
                false, // verified = false
            )
            .unwrap();
        assert_eq!(unverified_rec.credits_earned_by_node, 0);

        // Test deposit credits
        ledger.deposit_credits("test_topup_account", 500);
        let topup_acc = ledger.get_account("test_topup_account").unwrap();
        assert_eq!(topup_acc.balance_credits, 500);
    }
}

