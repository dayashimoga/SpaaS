# Smartphone-as-a-Service (SPaaS) / Universal Edge Compute Fabric

[![CI Pipeline](https://github.com/spaas-edge/spaas/actions/workflows/ci.yml/badge.svg)](https://github.com/spaas-edge/spaas/actions/workflows/ci.yml)
[![License: Apache-2.0 OR MIT](https://img.shields.io/badge/License-Apache--2.0%20OR%20MIT-blue.svg)](LICENSE)
[![Evidence](https://img.shields.io/badge/Evidence-PROVEN%20%26%20SIMULATION--PROVEN-brightgreen.svg)](#evidence-classification)

> **A production-grade, mobile-native distributed compute platform where voluntarily enrolled smartphones securely contribute unused CPU, GPU, NPU, storage, and network capacity, and developers submit workloads through a single unified API and CLI.**

Designed from the ground up so smartphones, laptops, desktops, servers, NAS, and specialized edge accelerators coalesce into one elastic, zero-trust compute fabric.

---

## Architecture Overview

```
                      +-----------------------------+
                      |    Developer / CLI / UI     |
                      +--------------+--------------+
                                     |
                                     v
                      +-----------------------------+
                      |   Ingress Gateway (8000)    |
                      +--------------+--------------+
                                     |
                                     v
                      +-----------------------------+
                      |    Control Plane (8080)     |
                      +--------------+--------------+
                                     |
              +----------------------+----------------------+
              |                                             |
              v                                             v
  +-----------------------+                     +-----------------------+
  |  Intelligent Edge     |                     |  Autonomous Recovery  |
  |  Scheduler Core       |                     |  Reconciler Loop      |
  +-----------+-----------+                     +-----------+-----------+
              |                                             |
              +----------------------+----------------------+
                                     |
                                     v
               +-------------------------------------------+
               |  Heterogeneous Edge Nodes (Voluntary)     |
               |  - Real Android Node App (Foreground Svc) |
               |  - Desktop / Server / NAS Agents          |
               |  - Simulation Lab (1 to 1000+ Nodes)      |
               +---------------------+---------------------+
                                     |
                                     v
               +-------------------------------------------+
               |  Sandboxed WebAssembly/WASI Runtime       |
               |  - Fuel/Gas Metering (Deterministic)      |
               |  - Linear Memory Ceiling (64MB)           |
               |  - Watchdog Hard Timeout                  |
               |  - Stdout/Stderr Buffer Quotas            |
               +---------------------+---------------------+
                                     |
                                     v
               +-------------------------------------------+
               |  Verification & Metering Engine           |
               |  - Ed25519 Result Signature Check         |
               |  - Byzantine Quorum Consensus             |
               |  - Idempotent Double-Entry Credit Ledger  |
               +-------------------------------------------+
```

---

## Core Flow

1. **Submission**: Developer prepares and cryptographically signs a versioned `WorkloadSpec` using Ed25519.
2. **Admission & Scheduling**: The Control Plane validates the submitter signature, and the multi-criteria `EdgeScheduler` evaluates the node fleet based on real battery state, AC charging, thermal status, unmetered Wi-Fi, CPU architecture, and historical reliability.
3. **Dispatch**: The workload and bytecode are dispatched to the selected eligible node.
4. **Sandboxed Execution**: Worker node executes the WebAssembly module inside a deterministic `wasmi` sandbox with fuel limits, memory isolation, and a timeout watchdog.
5. **Result Verification**: Node cryptographically signs the computed result digest with its private key; the Control Plane verifies the signature (or runs majority quorum consensus across redundant nodes).
6. **Metering**: The verifiable internal ledger records fuel, wall time, RAM, and bandwidth, updating provider credits with strict idempotency keys preventing double billing.

---

## Monorepo Layout

```
.
├── apps/
│   ├── android-node/         # Production Android (Kotlin + Jetpack Compose) Node
│   ├── web-console/          # Modern responsive Management Dashboard (Vite + CSS Tokens)
│   ├── control-plane/        # Axum-based high-concurrency Edge Orchestrator
│   ├── scheduler/            # Standalone distributed scheduler daemon
│   ├── gateway/              # Reverse proxy with rate limiting & TLS termination
│   ├── cli/                  # spaas CLI for developer and operator workflows
│   └── node-simulator/       # Heterogeneous simulation lab (1 to 1000+ nodes)
├── crates/
│   ├── protocol/             # Versioned specs, state machines, and RPC models
│   ├── security/             # Ed25519 signing, SHA-256 integrity, token auth
│   ├── workload-runtime/     # Sandboxed WebAssembly/WASI execution engine
│   ├── scheduler-core/       # Multi-attribute scoring, filters, and priority queues
│   ├── metering/             # Verifiable dual-entry credit ledger & idempotency
│   ├── verification/         # Cryptographic verification & Byzantine quorum consensus
│   ├── telemetry/            # Prometheus metrics registry & correlation IDs
│   └── node-agent/           # Edge daemon with auto-yield resource protection
├── deploy/                   # Podman Compose deployment definitions
├── containers/               # Containerfiles for zero-host-install toolchain
├── scripts/                  # Idempotent dev-up, test, build, clean, and acceptance runners
├── tests/                    # Integration, adversarial, and resilience test suite
└── docs/                     # 27 comprehensive architectural and operational manuals
```

---

## Quick Start (Podman-First / Zero Host Install)

### Prerequisites
- [Podman](https://podman.io/) or Docker
- [Git](https://git-scm.com/)

### 1. Launch Disposable Development Stack
```bash
# Windows PowerShell:
.\scripts\dev-up.ps1

# Linux / macOS:
./scripts/dev-up
```

Access points:
- **Management Web Console**: [http://localhost:3000](http://localhost:3000)
- **Control Plane API**: [http://localhost:8080](http://localhost:8080)
- **Ingress Gateway**: [http://localhost:8000](http://localhost:8000)
- **Prometheus Metrics**: [http://localhost:8080/metrics](http://localhost:8080/metrics)

### 2. Run Comprehensive Test Suite
```bash
.\scripts\test.ps1    # or ./scripts/test
```

### 3. Run Full Production Acceptance Gate
```bash
.\scripts\acceptance.ps1 -Full    # or ./scripts/acceptance --full
```

### 4. Build Production Artifacts
```bash
.\scripts\build.ps1    # or ./scripts/build
```

### 5. Tear Down & Clean
```bash
.\scripts\dev-down.ps1 # or ./scripts/dev-down
.\scripts\clean.ps1    # or ./scripts/clean
```

---

## Evidence Classification

Every feature in SPaaS is audited and strictly classified per Section 11 of the specification:

| Capability / Subsystem | Evidence Class | Certification Status |
| :--- | :--- | :--- |
| **WASM / WASI Sandbox & Fuel Metering** | `PROVEN` | Certified with 100% passing tests |
| **Ed25519 Signing & Verification** | `PROVEN` | Certified with 100% passing tests |
| **Intelligent Edge Scheduler Core** | `PROVEN` | Certified with 100% passing tests |
| **Metering Ledger & Idempotency** | `PROVEN` | Certified with 100% passing tests |
| **Node Disappearance & Recovery** | `PROVEN` | Certified with 100% passing tests |
| **Heterogeneous Fleet Simulation** | `SIMULATION-PROVEN` | Verified in Simulation Lab |
| **Android Foreground Compute App** | `IMPLEMENTED-UNPROVEN` | Fully implemented; requires device run |
| **Qualcomm NPU / AVF pKVM Acceleration**| `HARDWARE-REQUIRED` | Explicitly marked; not faked |

---

## Documentation Directory

Explore the complete technical manuals in [`docs/`](docs/):
- [Architecture Guide](docs/ARCHITECTURE.md)
- [Requirements Specification](docs/REQUIREMENTS.md)
- [Security & Threat Model](docs/SECURITY.md)
- [Workload Runtime Engine](docs/WORKLOAD_RUNTIME.md)
- [Intelligent Scheduler](docs/SCHEDULER.md)
- [Protocol & RPC Specification](docs/PROTOCOL.md)
- [API Reference](docs/API.md)
- [Developer Guide](docs/DEVELOPER_GUIDE.md)
- [Provider Guide](docs/PROVIDER_GUIDE.md)
- [Testing & Acceptance Manual](docs/TESTING.md)
- [Permanent Master Task Ledger (TODO)](TODO.md)
- [Permanent Append-Only Changelog](CHANGELOG.md)
- [Implementation Matrix](IMPLEMENTATION.md)
