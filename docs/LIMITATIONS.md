# SPaaS Known Limitations & Explicit Boundary Classifications

## 1. Evidence Classification of Subsystems

Per Section 11 and Section 19 of the SPaaS Specification, capabilities are explicitly classified with transparent evidence tiers:

| Capability | Classification | Empirical Verification Notes |
| :--- | :--- | :--- |
| **Deterministic WASI Interpreter** | `PROVEN` | Pure-Rust deterministic execution with instruction fuel ceilings verified in `crates/runtime` test suite. |
| **Ed25519 Cryptographic Verification**| `PROVEN` | Signature generation and canonical payload validation verified in `crates/security`. |
| **Multi-Attribute Intelligent Scheduler**| `PROVEN` | Pareto scoring across battery, thermal, network, and provider reliability verified in `crates/scheduler-core`. |
| **Double-Entry Metering Ledger** | `PROVEN` | Idempotency keys prevent duplicate billing on re-transmissions in `crates/metering`. |
| **Node Dropout & Rescheduling** | `PROVEN` | Autonomous reconciler recovery verified via integration test suite (`tests/integration`). |
| **Heterogeneous Node Simulator** | `SIMULATION-PROVEN` | Validated in Podman simulation harness (supporting 1 to 10,000 synthetic nodes). |
| **Android Native Foreground Service** | `IMPLEMENTED-UNPROVEN`| Complete Kotlin/Compose codebase implemented in `apps/android-node`; requires physical Android device/emulator for live execution. |
| **Qualcomm NPU / AVF pKVM Acceleration**| `HARDWARE-REQUIRED` | Requires physical Qualcomm Snapdragon NPU silicon or Android Virtualization Framework pKVM hypervisor. Marked unsupported when hardware absent. |

---

## 2. Practical Edge Limitations & Engineering Boundaries

### 2.1 Network Topology & Asymmetric Uplink
- **NAT Traversal**: Current edge dispatch uses outbound client long-polling and SSE heartbeats (`POST /api/v1/nodes/:id/heartbeat`). Incoming unsolicited ingress to mobile devices is blocked by carrier-grade NAT (CGNAT). Peer-to-peer WebRTC data channels are planned for v0.2.0.
- **Mobile Bandwidth**: Mobile cellular networks exhibit high uplink variance and latency spikes. Workload binaries should be kept under 5MB to avoid cellular data quota exhaustion.

### 2.2 Host OS Lifecycle & Aggressive OEM Optimization
- **Android Process Killing**: OEM battery managers (e.g., Samsung OneUI, Xiaomi MIUI) aggressively kill long-running background tasks. SPaaS mitigates this via a persistent sticky `FOREGROUND_SERVICE_DATA_SYNC` notification, but unexempted devices may face termination if system memory falls below critical thresholds.
- **Thermal Dissipation**: Mobile smartphones lack active fans. Sustained high-MIPS workloads will cause thermal throttling within 3-5 minutes, reducing throughput by 40-60%. The SPaaS scheduler accounts for this via `max_thermal_level` and dynamically adjusts capability weights.

### 2.3 Runtime Execution Throughput
- **Safety vs Native Speed**: SPaaS utilizes `wasmi`, a deterministic interpreted WebAssembly runtime, ensuring 100% reproducible gas metering and zero host memory safety hazards across heterogeneous CPU architectures (ARM64, x86_64, RISC-V). Interpreted execution is approximately 5x to 10x slower than unmetered native JIT (e.g., Wasmtime/V8), which is an intentional architectural trade-off for determinism and safety.

### 2.4 Byzantine Fault Tolerance & Result Verification
- **Single-Node vs Consensus Quorum**: By default, workloads run under `single_node` verification. In zero-trust untrusted public edge environments, submitters requiring mathematical proof against malicious compute providers should configure `hash_match` (dual-redundant execution) or `deterministic_replay` verification policies.
