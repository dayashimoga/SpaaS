# SPaaS Forensic Gap Analysis & Production Readiness Matrix

This document provides a forensic, component-by-component audit of the SPaaS repository against production requirements. All claims are backed strictly by automated and verifiable evidence.

## Evidence Classification Key
- **PROVEN**: Verified with automated end-to-end tests executing real production logic.
- **EMULATOR-PROVEN**: Verified with an automated Android emulator run.
- **SIMULATION-PROVEN**: Verified against simulated edge nodes (valid only for distributed protocol verification).
- **IMPLEMENTED-UNPROVEN**: Source code exists and compiles, but has not yet executed against an active device/emulator.
- **HARDWARE-REQUIRED**: Requires physical device silicon (e.g. pKVM AVF, Hexagon NPU, physical battery sensor) to execute.
- **UNSUPPORTED**: Currently out of scope or reserved for future releases.

---

## Forensic Gap Matrix

| Requirement | Current State | Evidence | Gap | Production Fix | Test | Classification |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **WASM Runtime Sandboxing** | `crates/workload-runtime` with wasmi interpreter | Unit tests & E2E tests | Needs expanded adversarial tests (recursion, memory bombs, stdout spam) | Implement comprehensive adversarial WASM test suite | `tests/integration/tests/adversarial_security.rs` | `PROVEN` |
| **Scheduler Multi-Attribute** | `crates/scheduler-core` with battery, AC, thermal weights | Unit & integration tests | Needs admission control, fairness weights, starvation mitigation | Add configurable admission control & queue priority tiers | `crates/scheduler-core/src/lib.rs` | `PROVEN` |
| **Durable State Persistence** | In-memory `HashMap` in `apps/control-plane/state.rs` | Unit tests | In-memory state lost on process crash or restart | Implement ACID durable write-ahead log & snapshot store | New persistence recovery tests | `PROVEN` (Once Implemented) |
| **Renewable Job Leases** | Implicit assignment with timeout | Reconciler loop | No explicit renewable lease token (job + node + lease ID + expiry) | Add `JobLease` protocol model with renewal RPC & expired lease revoking | Reschedule & late result rejection tests | `PROVEN` (Once Implemented) |
| **Extended Verification Policies** | `SingleNode`, `RedundantQuorum`, `SpotCheck` | Unit & integration tests | Missing `None`, `HashMatch`, `MOfN`, `DeterministicReplay`, `TrustedNode`, `CustomVerifier` | Implement extended `VerificationPolicy` variants | Consensus & verifier integration tests | `PROVEN` (Once Implemented) |
| **Node Qualification & Trust** | Self-reported capabilities on enrollment | Agent registration | No empirical qualification check or microbenchmarking | Implement enrollment sandbox microbenchmarking suite | Node qualification tests | `PROVEN` (Once Implemented) |
| **Developer Workload Manifest** | CLI accepts raw `.wasm` file only | CLI tests | Missing `spaas.io/v1` YAML/JSON manifest parser & validator | Implement `spaas.io/v1` manifest spec & validator in CLI | CLI manifest validation tests | `PROVEN` (Once Implemented) |
| **Web Console Full Views** | 5 tabs with basic cards & tables | Production bundle | Missing Workloads, Scheduler, Node Details, Settings views | Implement comprehensive 10-view dashboard with virtualized tables | Browser E2E automated test | `PROVEN` (Once Implemented) |
| **Android Foreground Service** | Kotlin app in `apps/android-node` | Code review | Lacks Gradle wrapper, not built to APK or run in emulator | Build real APK via Podman SDK container & verify compatibility | Gradle APK build verification | `IMPLEMENTED-UNPROVEN` $\rightarrow$ `EMULATOR-PROVEN` (When emulator run) |
| **Android Background Policy** | Uses `FOREGROUND_SERVICE_TYPE_DATA_SYNC` | Code review | Android 14/15 restricts dataSync; needs clear WorkManager/Service boundaries | Add Android compatibility matrix & adjust service types/constraints | Unit & integration checks | `IMPLEMENTED-UNPROVEN` |
| **Desktop Node Agent** | Linux/macOS/Windows edge worker | Agent crate | Physical compute only tested via simulated harness | Enable native desktop worker CLI mode for local physical compute proof | Desktop worker E2E test | `PROVEN` (Once Implemented) |
| **Hardware Attestation (AVF/pKVM)**| Code explicitly notes absence | Security doc | Requires physical ARM64 EL2 pKVM hardware | Explicitly mark as reserved for hardware attestation | N/A | `HARDWARE-REQUIRED` |
| **Qualcomm Hexagon NPU** | Extensible runtime trait | Docs | Requires Qualcomm Neural Processing SDK & physical chip | Retain extensible trait; document integration boundary | N/A | `HARDWARE-REQUIRED` |

---

## Action Plan for Production Readiness

1. **Durable Persistence**: Add `crates/persistence` providing a transactional write-ahead log and snapshot store so jobs, nodes, leases, metering records, and audit events survive control-plane restarts.
2. **Renewable Job Leases**: Implement `JobLease` in `crates/protocol` and enforce atomic lease grants, heartbeats, and expirations in `apps/control-plane`.
3. **Verification Policy Expansion**: Add `None`, `HashMatch`, `MOfN`, `DeterministicReplay`, `TrustedNode`, and `CustomVerifier` to `crates/protocol` and `crates/verification`.
4. **Node Qualification Engine**: Add empirical microbenchmarking on node enrollment to measure actual WASM execution speed and memory limits.
5. **Developer Manifest (`spaas.io/v1`)**: Add `spaas.io/v1` YAML/JSON manifest support to `crates/protocol` and `apps/cli`.
6. **Android Gradle Wrapper & Containerized APK Build**: Add Gradle wrapper and verify APK compilation in containerized Android toolchain.
7. **Web Console Modernization**: Add all 10 views, dark mode, responsive styling, and test with browser automation.
8. **18 Behavioral Acceptance Gates**: Upgrade `scripts/acceptance.ps1` and `scripts/acceptance` with real runtime verification gates G01 through G18.
