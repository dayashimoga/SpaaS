use spaas_protocol::job::JobResult;
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsensusOutcome {
    pub agreed_digest: String,
    pub agreeing_nodes: Vec<Uuid>,
    pub dissenting_nodes: Vec<Uuid>,
    pub is_consensus_reached: bool,
}

/// Evaluates quorum consensus across results submitted by multiple untrusted worker nodes
pub fn evaluate_consensus(results: &[JobResult], min_matching: u32) -> ConsensusOutcome {
    let mut digest_counts: HashMap<String, Vec<Uuid>> = HashMap::new();

    for res in results {
        digest_counts
            .entry(res.result_digest.clone())
            .or_default()
            .push(res.node_id);
    }

    // Find the digest with highest agreement
    let mut best_digest = String::new();
    let mut best_nodes: Vec<Uuid> = Vec::new();

    for (digest, nodes) in digest_counts {
        if nodes.len() > best_nodes.len() {
            best_digest = digest;
            best_nodes = nodes;
        }
    }

    let is_consensus = best_nodes.len() >= min_matching as usize;

    // Collect all dissenting nodes
    let mut dissenting = Vec::new();
    for res in results {
        if res.result_digest != best_digest {
            dissenting.push(res.node_id);
        }
    }

    ConsensusOutcome {
        agreed_digest: best_digest,
        agreeing_nodes: best_nodes,
        dissenting_nodes: dissenting,
        is_consensus_reached: is_consensus,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_consensus_evaluation() {
        let node1 = Uuid::new_v4();
        let node2 = Uuid::new_v4();
        let node3 = Uuid::new_v4();

        let r1 = JobResult {
            result_id: Uuid::new_v4(),
            job_id: Uuid::new_v4(),
            node_id: node1,
            exit_code: 0,
            stdout: "valid".into(),
            stderr: "".into(),
            result_digest: "hash_A".into(),
            fuel_consumed: 100,
            wall_time_ms: 10,
            peak_memory_bytes: 1024,
            node_signature: "sig1".into(),
            completed_at_ms: 1000,
        };

        let mut r2 = r1.clone();
        r2.result_id = Uuid::new_v4();
        r2.node_id = node2;

        let mut r3 = r1.clone();
        r3.result_id = Uuid::new_v4();
        r3.node_id = node3;
        r3.result_digest = "hash_B_malicious".into();

        // 2 of 3 match hash_A -> min_matching is 2
        let outcome = evaluate_consensus(&[r1, r2, r3], 2);
        assert!(outcome.is_consensus_reached);
        assert_eq!(outcome.agreed_digest, "hash_A");
        assert_eq!(outcome.agreeing_nodes.len(), 2);
        assert_eq!(outcome.dissenting_nodes, vec![node3]);
    }
}
