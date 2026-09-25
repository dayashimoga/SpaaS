# SPaaS Acceptance Gate Specification

## 1. Single Command Production Acceptance Gate
The command:
```powershell
.\scripts\acceptance.ps1 -Full    # or ./scripts/acceptance --full
```
is the sole gating mechanism for certifying release readiness.

---

## 2. Mandatory Verification Gates
1. **Compilation & Lint**: Clean `cargo check --workspace` and linter checks with zero warnings.
2. **Cryptographic Suite**: 100% pass on Ed25519 signing and verification.
3. **WASM Sandbox & Gas Metering**: Deterministic termination of infinite loops.
4. **Intelligent Scheduler**: Multi-attribute ranking matching specified criteria.
5. **Security Adversarial Suite**: Defenses against tampering, forging, and replay attacks.
6. **Node Disappearance Resilience**: Autonomous retry and rescheduling upon node failure.
7. **End-to-End Lifecycle**: Real WASM execution, result verification, and credit ledger deduction.
8. **Web Production Bundle**: Successful compilation of Web Management Console.
9. **Live Microservices Smoke Test**: Live Control Plane startup, health verification, and simulated node enrollment.
10. **Certification Report**: Generation of machine-readable `acceptance-report.json`.

---

## 3. Evidence Classification
- **PROVEN**: Tested and verified on target platform architecture.
- **SIMULATION-PROVEN**: Validated inside the distributed simulation lab.
- **IMPLEMENTED-UNPROVEN**: Code complete and unit tested; awaiting physical hardware deployment.
- **HARDWARE-REQUIRED**: Requires physical specialized silicon (e.g. Qualcomm NPU, AVF pKVM).
