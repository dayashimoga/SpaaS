pub mod consensus;
pub mod engine;

pub use consensus::{evaluate_consensus, ConsensusOutcome};
pub use engine::VerificationEngine;
