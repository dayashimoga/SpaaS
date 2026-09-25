# SPaaS Platform Requirements Specification

## 1. Product Requirements

### 1.1 Core Vision
Smartphone-as-a-Service (SPaaS) is a universal edge compute platform enabling voluntary smartphone owners to securely lease idle CPU, RAM, storage, and networking to developers running distributed, sandboxed computations.

### 1.2 Non-Functional Requirements
- **Zero Host Installation**: All developer, test, and production builds must run cleanly inside Podman/container environments without polluting host operating systems.
- **Strict Mobile Owner Privacy**: The Android agent must NEVER request or access sensitive device data, including contacts, SMS, photos, location, camera, microphone, or external shared storage.
- **Resource Non-Interference**: Mobile computing must immediately yield when user activity, low battery, thermal throttling, or metered cellular networks are detected.
- **Zero Trust Security**: Workload submitters and worker nodes are mutually untrusted. All workloads must be signed and executed in isolated sandboxes; all results must be cryptographically verifiable.
- **Failure Resilience**: The control plane must treat edge nodes as inherently transient and ephemeral, guaranteeing job recovery and rescheduling.

---

## 2. Functional Requirements Matrix

| Requirement ID | Subsystem | Description | Compliance Status |
| :--- | :--- | :--- | :--- |
| **REQ-ARC-01** | Architecture | Universal fabric supporting Android, desktop, server, and IoT | COMPLETE |
| **REQ-MOD-01** | Workload Model | Versioned specification with signed digests and resource limits | COMPLETE |
| **REQ-RUN-01** | Runtime | WebAssembly/WASI sandbox with fuel metering and memory ceilings | COMPLETE |
| **REQ-SCH-01** | Scheduler | Multi-attribute ranking (thermals, battery, charging, Wi-Fi, load) | COMPLETE |
| **REQ-AND-01** | Android Node | Foreground Service with persistent notification and pause controls | COMPLETE |
| **REQ-AND-02** | Android Node | Real Android Battery, PowerManager, and Connectivity API listeners | COMPLETE |
| **REQ-SEC-01** | Security | Ed25519 workload signing and result verification | COMPLETE |
| **REQ-SEC-02** | Security | Replay-resistant bearer auth tokens and path traversal scrubbers | COMPLETE |
| **REQ-VER-01** | Verification | Single node signature check and Byzantine quorum consensus | COMPLETE |
| **REQ-MET-01** | Metering | Dual-entry accounting with idempotency keys preventing duplicates | COMPLETE |
| **REQ-SIM-01** | Simulation | Heterogeneous node simulation lab supporting 1 to 1000+ nodes | COMPLETE |
| **REQ-CLI-01** | CLI | Full developer CLI (`spaas`) for node, job, and system actions | COMPLETE |
| **REQ-DSH-01** | Web Console | Modern dark-mode management console with zero placeholder data | COMPLETE |
