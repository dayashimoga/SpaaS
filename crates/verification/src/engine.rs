use crate::consensus::{evaluate_consensus, ConsensusOutcome};
use spaas_protocol::error::ProtocolError;
use spaas_protocol::job::JobResult;
use spaas_security::signing::verify_job_result;
use tracing::{info, warn};

pub struct VerificationEngine;

impl VerificationEngine {
    pub fn new() -> Self {
        Self
    }

    /// Verifies single node execution output against cryptographic signature and hash
    pub fn verify_single_result(
        &self,
        result: &JobResult,
        node_pubkey: &str,
    ) -> Result<(), ProtocolError> {
        verify_job_result(result, node_pubkey).map_err(|e| {
            warn!(node_id = %result.node_id, error = %e, "Cryptographic verification failed for job result");
            ProtocolError::SignatureVerificationFailed(e.to_string())
        })?;
        info!(job_id = %result.job_id, node_id = %result.node_id, "Result cryptographically verified");
        Ok(())
    }

    /// Evaluates multi-node redundant quorum consensus
    pub fn verify_redundant_quorum(
        &self,
        results: &[JobResult],
        min_matching: u32,
    ) -> Result<ConsensusOutcome, ProtocolError> {
        if results.is_empty() {
            return Err(ProtocolError::ConsensusFailed {
                agreed: 0,
                total: 0,
            });
        }

        let outcome = evaluate_consensus(results, min_matching);
        if !outcome.is_consensus_reached {
            warn!(
                agreed = outcome.agreeing_nodes.len(),
                total = results.len(),
                min_matching,
                "Quorum consensus threshold NOT reached"
            );
            return Err(ProtocolError::ConsensusFailed {
                agreed: outcome.agreeing_nodes.len() as u32,
                total: results.len() as u32,
            });
        }

        if !outcome.dissenting_nodes.is_empty() {
            warn!(
                dissenting_nodes = ?outcome.dissenting_nodes,
                "Detected Byzantine or corrupted result from dissenting worker nodes"
            );
        }

        info!(
            agreed_digest = %outcome.agreed_digest,
            agreeing_count = outcome.agreeing_nodes.len(),
            "Quorum consensus accepted"
        );

        Ok(outcome)
    }

    /// Verifies that the result digest matches an expected pre-computed hash
    pub fn verify_hash_match(
        &self,
        result: &JobResult,
        expected_digest: &str,
    ) -> Result<(), ProtocolError> {
        if result.result_digest != expected_digest {
            warn!(
                expected = expected_digest,
                actual = %result.result_digest,
                "Result digest did not match expected hash"
            );
            return Err(ProtocolError::HashMismatch {
                expected: expected_digest.to_string(),
                actual: result.result_digest.clone(),
            });
        }
        info!(job_id = %result.job_id, "Hash match verification succeeded");
        Ok(())
    }
}

impl Default for VerificationEngine {
    fn default() -> Self {
        Self::new()
    }
}
