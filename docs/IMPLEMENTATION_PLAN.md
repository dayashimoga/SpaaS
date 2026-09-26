# SPaaS Universal Edge Compute Fabric — Comprehensive Implementation Plan

**Author:** Principal Distributed Systems Architect, Rust/Android Engineer, DevSecOps & QA Lead  
**Document Version:** 2.0.0-PROD  
**Baseline Standard:** 13-Domain Production Engineering Master Specification  
**Execution Horizon:** 6 Sequential, Integrated Sprints with Strict Verification Gates

---

## Architecture Overview

```
                                ┌───────────────────────────────────────────────┐
                                │             Cloudflare Edge                   │
                                │   https://spaas-console.pages.dev             │
                                └──────────────────────┬────────────────────────┘
                                                       │ HTTPS (Direct / Tunnel)
                                                       ▼
┌───────────────────────────┐           ┌───────────────────────────────────────────────┐
│     Physical Android      │  HTTPS/WSS│         Public Ingress Gateway /              │
│       Smartphones         │◄─────────►│            Cloudflare Tunnel                  │
│ (NAT / Cellular / Wi-Fi)  │           │   (https://<tenant>.trycloudflare.com)        │
└───────────────────────────┘           └──────────────────────┬────────────────────────┘
                                                               │ Local Socket
                                                               ▼
┌───────────────────────────┐           ┌───────────────────────────────────────────────┐
│     Desktop Workers       │  Localhost│              Rust Control Plane               │
│ (CLI / Container / PS1)   │◄─────────►│     (:8080 - Axum + Tokio + WAL + wasmi)      │
└───────────────────────────┘           └───────────────────────────────────────────────┘
```

---

## Sprint Implementation Roadmap

### Sprint 1: Production Remote Connectivity, Cloudflare Tunnel & Ingress Architecture
**Goal:** Guarantee reliable global connectivity between Cloudflare Pages, remote smartphones, and the Rust control plane without router port forwarding or mixed-content errors.

#### Deliverables:
1. **Cloudflare Tunnel Deployment Manifests (`deploy/tunnel/`):**
   - Containerized `cloudflared` daemon service configuration for Podman/Docker.
   - Quick tunnel launcher script `scripts/start-tunnel.ps1` outputting public HTTPS ingress endpoint.
2. **Environment Configuration Decoupling:**
   - Multi-environment profiles (`local`, `emulator`, `staging`, `production`) configured via `.env` and environment variables.
   - Strict removal of hardcoded LAN IPs (`192.168.0.111`) and loopback addresses (`127.0.0.1`, `10.0.2.2`) from production Android code.
3. **Web Console Dynamic Ingress Modal:**
   - "Connect Control Plane" modal supporting 1-click Cloudflare Tunnel URL entry, instant verification, and automatic persistence in `localStorage`.
   - Clear diagnostic feedback for HTTPS Mixed-Content scenarios with browser toggle instructions.
4. **Rust Control Plane Ingress Hardening:**
   - Dynamic CORS handling supporting both `*.pages.dev` and custom domains.
   - WebSocket/SSE keep-alive pings (15s heartbeat) to prevent cellular carrier NAT timeouts.

#### Acceptance Criteria & Regression Gates:
- `scripts/start-tunnel.ps1` successfully establishes a public HTTPS ingress tunnel.
- Cloudflare Pages console at `https://*.pages.dev` establishes two-way communication with the control plane over HTTPS/WSS without mixed-content errors.
- Outbound worker connections successfully maintain SSE/WSS connectivity across Wi-Fi-to-cellular handover.

---

### Sprint 2: Persistent Cryptographic Identity & Zero-Friction Enrollment
**Goal:** Deliver a seamless, 1-tap onboarding experience with persistent Ed25519 node identities that survive application restarts.

#### Deliverables:
1. **Android Encrypted Keystore Identity Store:**
   - `EncryptedDeviceIdentityStore.kt` using Android Keystore to generate and securely store the Ed25519 / EC-256 node keypair and UUID.
   - Durably persist `pairedNodeId`, `authToken`, and `serverBaseUrl` in `EncryptedSharedPreferences`.
2. **Deep Link Intent Handling (`spaas://pair`):**
   - Register deep link intent filter in `AndroidManifest.xml`.
   - On opening `spaas://pair?code=SP-XXXX&server=https%3A%2F%2F...`, the app automatically validates server TLS, fills the token, and initiates registration.
3. **Control Plane Replay Prevention & Device Management:**
   - Single-use pairing token consumption with cryptographic nonce validation to reject replayed requests.
   - Endpoints for node renaming, state transition (`Active`, `Paused`, `Draining`), and permanent cryptographic revocation.

#### Acceptance Criteria & Regression Gates:
- Physical Android node survives process kill (`am force-stop dev.spaas.node`) and reconnects with identical `node_id` and public key.
- Replaying a consumed pairing token returns `HTTP 409 Conflict` or `HTTP 401 Unauthorized`.
- Device revocation invalidates all future heartbeats and job dispatches.

---

### Sprint 3: Genuine WASM Workload Runtime Engine & Multi-Dimensional Hardware Discovery
**Goal:** Eliminate all synthetic/mock branches in Android workload execution and deliver empirical, reproducible hardware benchmarks.

#### Deliverables:
1. **Android Genuine WASM Execution Engine:**
   - Implement real WebAssembly instruction execution in Android using native JavaScript/WASM V8 engine bridge or embedded interpreter.
   - Eliminate all mock text generation in `WasmRuntimeEngine.kt`.
   - Real linear memory allocation bounds, fuel metering, and standard output capture.
2. **Empirical Mobile Hardware Benchmarking:**
   - Microbenchmarks executing on node enrollment and periodic requalification:
     - CPU: Single-core & multi-core integer loops (MIPS), floating-point throughput (MFLOPS).
     - Memory: Sequential read/write bandwidth (MB/s) and allocation latency.
     - WASM: Bytecode instruction execution rate (fuel/ms).
     - Network: RTT latency, jitter, and download bandwidth to control plane.
3. **Honest Accelerator Reporting:**
   - Report GPU/NPU status as `UNTESTED` unless an actual compute shader/inference task executes successfully.
   - Versioned benchmark records with timestamps, battery levels, and thermal conditions.

#### Acceptance Criteria & Regression Gates:
- Android node executes arbitrary valid WASM binaries and produces byte-for-byte identical output digests to the Rust `wasmi` reference engine.
- Android unit tests (`WasmComputeTest.kt`) pass 100% against real compiled WASM fixtures.
- Dashboards display empirical benchmark scores with explicit `UNTESTED` flags on unverified accelerators.

---

### Sprint 4: Workload-Aware Distributed Scheduler & Multi-Objective Placement
**Goal:** Implement intelligent, multi-objective workload placement with transparent scheduling rationale and scalability up to 10,000 nodes.

#### Deliverables:
1. **Multi-Objective Placement Optimizer (`crates/scheduler-core`):**
   - Hard eligibility filter: Runtime type, required architecture, available RAM, owner policies (charging, Wi-Fi, battery).
   - Soft scoring function: Normalized multi-attribute vector (measured latency, CPU capacity, energy score, historical reliability, queue depth).
2. **"Why This Device?" Explanation API:**
   - Expose `SchedulerDecision` containing selected node, candidate rankings, rejected nodes with reasons, and estimated completion time.
   - Render transparent decision breakdown in Web Console and Android dashboards.
3. **10,000-Node Scalability Benchmark:**
   - Stress-test scheduler with 100, 1,000, 5,000, and 10,000 registered nodes under concurrent job submissions.
   - Enforce p50 scheduling latency under 5ms at 10,000 nodes.

#### Acceptance Criteria & Regression Gates:
- Workload requesting 32MB RAM is rejected on nodes with <32MB available without scheduling failure.
- Web Console displays detailed "Why This Device?" card for every scheduled job.
- Benchmark suite passes 10,000-node simulated dispatch with zero deadlocks.

---

### Sprint 5: Granular Owner Security Controls, Forensic Ledger & Real Workload Catalog
**Goal:** Empower mobile device owners with unbypassable resource restrictions, auditable accounting, and production workload templates.

#### Deliverables:
1. **Enforceable Real-Time Resource Watchdog:**
   - In-execution restriction enforcement: Check battery level, thermal state, and charging status during WASM execution loops; abort immediately if limits are breached.
   - Prominent Emergency Stop button on Android UI and notification drawer.
2. **Auditable Double-Entry Ledger (`crates/metering`):**
   - Idempotent settlement: Credit transactions record `job_id`, `node_id`, `fuel_consumed`, `wall_time_ms`, and timestamp.
   - Strict replay prevention preventing double-crediting of retried or redundant jobs.
3. **Production Workload Catalog:**
   - Provide pre-compiled, deterministic WASM binaries for SHA-256 benchmarking, Prime Sieve, Matrix Multiplication, and JSON Transformation.
   - Input file payload streaming and downloadable result artifacts.

#### Acceptance Criteria & Regression Gates:
- Unplugging charger during execution on a charging-only policy immediately suspends or safely cancels the task.
- Submitting identical job result twice results in idempotent single credit settlement.
- Catalog workloads execute successfully across physical phone, desktop worker, and container runtimes.

---

### Sprint 6: Complete Web & Mobile Visual Overhaul, CI/CD Pipeline & Final Acceptance
**Goal:** Deliver cohesive, modern production applications, comprehensive CI/CD automation, and verified final acceptance.

#### Deliverables:
1. **Web Console Visual Polish:**
   - 6-tab cohesive layout (`Overview`, `Devices`, `Workloads`, `Jobs`, `Usage`, `Advanced`).
   - Prominent disaggregation of Physical, Emulator, Desktop, and Simulated nodes.
   - Fluid dark theme, responsive sidebars, zero horizontal overflow, and real-time SSE updates.
2. **Android Compose Visual Overhaul:**
   - 6-tab navigation (`Home`, `Performance`, `Controls`, `Activity`, `Earnings`, `Security`).
   - Clean capability charts, live execution logs, and granular policy sliders.
3. **GitHub CI/CD Automation:**
   - Reproducible multi-platform builds (Linux, Windows, macOS).
   - Containerized Android APK build and apksigner v2 verification.
   - Automated Cloudflare Pages deployment with auto-project initialization.
4. **Final Acceptance Execution:**
   - Execute complete acceptance suite (`scripts/acceptance.ps1 -Full`) verifying all 22 behavioral gates.
   - Publish complete walkthrough artifact with executable evidence.

#### Acceptance Criteria & Regression Gates:
- CI pipeline passes 100% on every commit to `main`.
- Web Console and Android APK pass visual inspection with zero console errors.
- Final acceptance report records all gates as PROVEN or PHYSICAL-DEVICE-PROVEN with zero unhandled failures.
