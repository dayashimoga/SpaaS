use serde::{Deserialize, Serialize};
use std::fmt;

/// Verification Evidence Classification per SPaaS Specification (Section 11)
/// Never promote IMPLEMENTED_UNPROVEN, HARDWARE_REQUIRED, or UNSUPPORTED to production-proven.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum VerificationEvidenceClass {
    /// Fully verified on real production target hardware with passing tests
    Proven,
    /// Verified on an official platform emulator (e.g. Android Emulator via AVD)
    EmulatorProven,
    /// Verified inside the distributed system simulation lab (Podman/synthetic nodes)
    SimulationProven,
    /// Fully coded and structurally integrated, but lacking hardware runtime execution
    ImplementedUnproven,
    /// Requires specific physical hardware (e.g., Qualcomm NPU, AVF pKVM, Secure Element)
    HardwareRequired,
    /// Explicitly unsupported on the specified architecture or platform
    Unsupported,
}

impl VerificationEvidenceClass {
    /// Returns true if this evidence class permits production certification
    pub fn is_production_certified(&self) -> bool {
        matches!(self, Self::Proven)
    }

    /// Returns true if verified via simulated or emulated environments
    pub fn is_test_verified(&self) -> bool {
        matches!(
            self,
            Self::Proven | Self::EmulatorProven | Self::SimulationProven
        )
    }

    /// Returns a human-readable display label
    pub fn label(&self) -> &'static str {
        match self {
            Self::Proven => "PROVEN",
            Self::EmulatorProven => "EMULATOR-PROVEN",
            Self::SimulationProven => "SIMULATION-PROVEN",
            Self::ImplementedUnproven => "IMPLEMENTED-UNPROVEN",
            Self::HardwareRequired => "HARDWARE-REQUIRED",
            Self::Unsupported => "UNSUPPORTED",
        }
    }
}

impl fmt::Display for VerificationEvidenceClass {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.label())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_evidence_classification_promotion_rules() {
        assert!(VerificationEvidenceClass::Proven.is_production_certified());
        assert!(!VerificationEvidenceClass::EmulatorProven.is_production_certified());
        assert!(!VerificationEvidenceClass::SimulationProven.is_production_certified());
        assert!(!VerificationEvidenceClass::ImplementedUnproven.is_production_certified());
        assert!(!VerificationEvidenceClass::HardwareRequired.is_production_certified());
        assert!(!VerificationEvidenceClass::Unsupported.is_production_certified());

        assert!(VerificationEvidenceClass::SimulationProven.is_test_verified());
        assert!(VerificationEvidenceClass::EmulatorProven.is_test_verified());
        assert!(!VerificationEvidenceClass::ImplementedUnproven.is_test_verified());
        assert!(!VerificationEvidenceClass::HardwareRequired.is_test_verified());
        assert!(!VerificationEvidenceClass::Unsupported.is_test_verified());

        // Labels and Display
        assert_eq!(format!("{}", VerificationEvidenceClass::Proven), "PROVEN");
        assert_eq!(
            format!("{}", VerificationEvidenceClass::EmulatorProven),
            "EMULATOR-PROVEN"
        );
        assert_eq!(
            format!("{}", VerificationEvidenceClass::SimulationProven),
            "SIMULATION-PROVEN"
        );
        assert_eq!(
            format!("{}", VerificationEvidenceClass::ImplementedUnproven),
            "IMPLEMENTED-UNPROVEN"
        );
        assert_eq!(
            format!("{}", VerificationEvidenceClass::HardwareRequired),
            "HARDWARE-REQUIRED"
        );
        assert_eq!(
            format!("{}", VerificationEvidenceClass::Unsupported),
            "UNSUPPORTED"
        );
    }

    #[test]
    fn test_serialization() {
        let json = serde_json::to_string(&VerificationEvidenceClass::SimulationProven).unwrap();
        assert_eq!(json, "\"SIMULATION_PROVEN\"");
        let deserialized: VerificationEvidenceClass = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, VerificationEvidenceClass::SimulationProven);
    }
}
