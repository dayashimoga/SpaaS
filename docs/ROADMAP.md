# SPaaS Technical Architecture Roadmap

## 1. Strategic Vision

SPaaS transforms hundreds of millions of voluntary consumer mobile devices into a high-throughput, environmentally green, distributed edge compute fabric. By combining deterministic WebAssembly sandboxing, multi-attribute intelligent scheduling, and cryptographic verification, SPaaS delivers decentralized computing with enterprise-grade reliability and zero-trust security.

---

## 2. Release Progression & Milestones

### Milestone 1: Production Core Foundation (Current v0.1.0) — COMPLETED
- [x] **Modular Monorepo Architecture**: Clean separation across 10 Rust crates, Android native app, and web management console.
- [x] **Deterministic WebAssembly Engine**: `wasmi` interpreter enforcing exact instruction fuel ceilings and isolated linear memory.
- [x] **Pareto Multi-Attribute Scheduler**: Scoring based on measured MIPS, RTT, battery percentage, thermal headroom, provider reliability, cost, and geographical region affinity.
- [x] **Zero-Trust Security & Cryptography**: Ed25519 digital signatures, canonical serialization, monotonic lease nonces, and replay-protected token authentication.
- [x] **Dual-Entry Metering Ledger**: Idempotent credit deduction, provider rewards, and transparent settlement formulas denominated in TEST CREDITS.
- [x] **Real Android 15 Worker**: Jetpack Compose frontend, persistent foreground service, dynamic thermal and battery state monitoring.
- [x] **Responsive Web Console**: Pure JS/CSS design system with live SSE telemetry, dual-mode manifest studio, and device pairing workflows.
- [x] **Automated Production Acceptance Gate**: 10-gate verification script (`scripts/acceptance.ps1 -Full`) ensuring zero regressions.

---

### Milestone 2: Edge AI & Peer-to-Peer Fabric (Target v0.2.0)
- [ ] **ONNX Runtime & Mobile AI Inference**: Pluggable runtime for small language models (e.g. MobileLLM, Gemma 2B) and computer vision tasks utilizing smartphone Hexagon/Tensor NPUs.
- [ ] **Direct WebRTC / libp2p Data Channels**: Peer-to-peer data plane bypassing control plane ingress for large dataset transfers and direct device-to-device results.
- [ ] **Android Virtualization Framework (AVF)**: Hardware-enforced microVM execution via pKVM on eligible Android 14+ devices supporting protected virtualization.
- [ ] **Bluetooth Low Energy (BLE) Mesh Enrollment**: Localized ad-hoc discovery and enrollment of co-located mobile workers without internet connectivity.
- [ ] **Decentralized Settlement Boundary**: Pluggable micro-payment gateways (e.g. Bitcoin Lightning Network / stablecoin smart contracts) for optional real-world credit redemption.

---

### Milestone 3: Universal Mesh Scale & Hardware Accelerators (Target v0.3.0)
- [ ] **WebGPU & Vulkan Compute**: Unlocking mobile Adreno and Mali GPUs for parallel tensor and matrix operations within sandboxed environments.
- [ ] **Live Incremental State Migration**: Checkpointing and live migration of long-running WASM workloads between mobile devices when thermal or battery limits are reached.
- [ ] **Multi-Region Control Plane Federation**: Raft-replicated consensus cluster for control plane high availability across geographical edge regions.
- [ ] **Succinct Zero-Knowledge Execution Proofs (zk-STARKs)**: Mathematical proofs of execution correctness, eliminating redundant execution overhead in adversarial environments.

---

## 3. Technical Risk Matrix & Mitigation Strategy

| Architectural Risk | Likelihood | Impact | Planned Mitigation |
|---|---|---|---|
| **Aggressive Mobile OS Process Killing** | High | High | Sticky foreground services, JobScheduler fallback, and autonomous reconciler lease forfeiture. |
| **Edge Mobile Bandwidth Saturation** | Medium | Medium | Content-addressed artifact caching and binary delta compression. |
| **Byzantine Malicious Results** | Medium | Critical | Multi-node consensus (`hash_match`), deterministic replay, and zero-trust verification pipelines. |
| **Device Battery Degradation** | Low | High | Mandatory hardware safeguards, unmetered Wi-Fi constraints, and low-battery auto-yield thresholds. |
