# SPaaS Known Limitations & Explicit Boundary Classifications

Per Section 11 and Section 19 of the SPaaS Specification, capabilities are explicitly classified with transparent evidence:

---

## 1. Evidence Classification of Subsystems

| Capability | Classification | Notes |
| :--- | :--- | :--- |
| **WebAssembly WASI Interpreter** | `PROVEN` | Pure-Rust deterministic execution with fuel limits verified via unit tests. |
| **Ed25519 Cryptographic Verification**| `PROVEN` | Digital signature verification over canonical byte payloads verified via test suite. |
| **Multi-Attribute Intelligent Scheduler**| `PROVEN` | Battery, thermal, and network constraint ranking verified via unit tests. |
| **Double-Entry Metering Ledger** | `PROVEN` | Idempotency keys prevent duplicate billing on re-transmissions. |
| **Node Dropout & Rescheduling** | `PROVEN` | Autonomous reconciler recovery verified via integration tests. |
| **Heterogeneous Node Simulator** | `SIMULATION-PROVEN` | Validated in Podman simulation lab (1 to 1000+ nodes). |
| **Android Native Foreground Service** | `IMPLEMENTED-UNPROVEN`| Complete Kotlin/Compose codebase implemented; requires physical Android device/emulator for live execution. |
| **Qualcomm NPU / AVF pKVM Acceleration**| `HARDWARE-REQUIRED` | Requires physical Qualcomm Snapdragon NPU or Android Virtualization Framework hardware support. Explicitly marked unsupported when absent. |

---

## 2. Practical Edge Limitations
1. **Network NAT Traversal**: Current edge dispatch relies on worker HTTP long-polling (`/poll`). Direct peer-to-peer WebRTC / QUIC data channels are planned for v0.2.0.
2. **Volatile Memory Lifetimes**: Edge smartphones may be killed by OEM battery optimizations if the user removes the foreground notification.
3. **Execution Throughput**: As an interpreted bytecode sandbox, `wasmi` prioritizes safety, determinism, and fuel metering over raw JIT peak native speeds.
