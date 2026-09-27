# SPaaS Universal Edge Compute Fabric — Production Master Implementation Plan

**Document Version:** 3.0.0-PROD  
**Author:** Principal Distributed Systems Architect, Rust/Android Engineer, Cloudflare/Google Cloud Specialist, DevSecOps & QA Lead  
**Execution Horizon:** 8 Deployable Sprints with Strict Verification Gates & Rollback Protocols  
**Reference Specification:** [REQUIREMENTS_TRACEABILITY.md](file:///h:/SpaaS/REQUIREMENTS_TRACEABILITY.md) & [GAP_ANALYSIS.md](file:///h:/SpaaS/GAP_ANALYSIS.md)

---

## 1. Master Architecture Overview

```
                                      ┌────────────────────────────────────────────────────────┐
                                      │             Cloudflare Global Edge Network             │
                                      │   https://spaas-console.pages.dev (Cloudflare Pages)   │
                                      └───────────────────────────┬────────────────────────────┘
                                                                  │ HTTPS / WSS
                                                                  ▼
                                      ┌────────────────────────────────────────────────────────┐
                                      │     PRIMARY CONTROL PLANE: Cloudflare Workers + DO     │
                                      │   - Public HTTPS & WebSocket API (wrangler deploy)     │
                                      │   - CoordinatorDO: SQLite Storage (ctx.storage.sql)    │
                                      │   - WebSocket Hibernation API (Zero-Cost Idle Workers) │
                                      │   - DO Alarms: Lease Sweeps & Background Reconciler    │
                                      └─────────────┬────────────────────────────▲─────────────┘
                                                    │                            │
                                      Periodic Sync │ Authenticated Checkpoint   │ Safe Failback
                                                    ▼                            │ Synchronization
                                      ┌──────────────────────────────────────────┴─────────────┐
                                      │     BACKUP CONTROL PLANE: Google Cloud Run Standby     │
                                      │   - Rust Control Plane Container (min-instances: 0)    │
                                      │   - DORMANT STANDBY until Operator-Approved Activation │
                                      │   - Monotonic Epoch Fencing & Split-Brain Prevention   │
                                      │   - Independently Reachable Failover Web & REST Origin │
                                      └────────────────────────────────────────────────────────┘
                                                                  ▲
                                                                  │ Dual-Endpoint
                                                                  │ Failover
                                      ┌───────────────────────────┴────────────────────────────┐
                                      │       OUTBOUND COMPUTE FABRIC (NAT / CGNAT / Wi-Fi)    │
                                      │                                                        │
                                      │  📱 Physical Android Phones     💻 Desktop Workers     │
                                      │  - Persistent Keystore Identity - Sandboxed wasmi      │
                                      │  - Real WASM Stack VM           - Deterministic Gas    │
                                      │  - Locally Enforced Safety      - CPU/RAM Limits       │
                                      └────────────────────────────────────────────────────────┘
```

---

## 2. Eight Deployable Sprints Specification

### Sprint 1: Forensic Audit, Requirements Traceability & Architecture Decision Records
- **Objective:** Establish the comprehensive baseline, reproduce previous failure modes, audit all 13 domains, generate architecture decision records (ADRs), and formalize the 8-sprint execution plan.
- **Deliverables:**
  1. `REQUIREMENTS_TRACEABILITY.md` mapping every requirement to code, severity, tests, and evidence classification.
  2. `GAP_ANALYSIS.md` detailing forensic findings, root causes, and multi-cloud architectural imperatives.
  3. `IMPLEMENTATION_PLAN.md` with 8 deployable sprints, rollback procedures, acceptance gates, and cost models.
  4. Suite of 7 Architecture Decision Records in `docs/adr/` (ADR-001 through ADR-007).
- **Architecture Changes:** None (Analysis, documentation, and governance phase).
- **Acceptance Gates:** S1-G1 (100% requirements mapped), S1-G2 (Zero unclassified gaps), S1-G3 (All 7 ADRs authored).
- **Regression Tests:** Existing 22 gates in `scripts/acceptance.ps1` pass 100%.
- **Rollback Procedure:** Git commit revert.
- **Cost Estimate:** $0.00.

---

### Sprint 2: Cloudflare Primary Control Plane, SQLite Durable Objects & API Gateway
- **Objective:** Build and deploy the primary serverless control plane to Cloudflare Workers + Durable Objects with SQLite transactional storage, eliminating local daemon dependencies.
- **Deliverables:**
  1. `apps/cloudflare-control-plane/`:
     - Cloudflare Worker handling public HTTPS `/api/v1/*` routes, CORS, and rate limiting.
     - `CoordinatorDO`: Durable Object implementing transactional SQLite tables (`nodes`, `pairing_tokens`, `workloads`, `jobs`, `leases`, `ledger`, `audit_log`, `meta`).
     - WebSocket Hibernation API: allows thousands of idle phones to maintain persistent connections with zero compute cost.
     - DO Alarms: automatic lease expiration and orphan job reconciliation.
  2. Compatibility layer matching existing Rust protocol schemas and Ed25519 signature verification.
  3. `wrangler.toml` configuration and local emulation testing with `wrangler dev` (workerd).
- **Architecture Changes:** Migration of authoritative production state from local host filesystem WAL to Cloudflare DO SQLite.
- **Acceptance Gates:** S2-G1 (Worker builds and passes TypeScript/Wasm test suite), S2-G2 (SQLite schema migration executes without errors), S2-G3 (REST API compatibility verified against `apps/cli`).
- **Regression Tests:** `cargo test -p spaas-protocol`, `apps/cloudflare-control-plane` unit test suite.
- **Rollback Procedure:** Repoint Web Console `VITE_API_BASE` back to Cloudflare Tunnel or local host endpoint.
- **Cost Estimate:** $0.00 (Workers Free: 100,000 req/day; DO Free Tier: 1,000,000 requests/mo).

---

### Sprint 3: Zero-Friction Remote Enrollment, Android/Desktop Connectivity & Keystore Identity
- **Objective:** Fix all Android/web connectivity defects, implement zero-friction dual-endpoint onboarding, and ensure cryptographic keys survive process recreation.
- **Deliverables:**
  1. Android `EncryptedDeviceIdentityStore.kt` using Android Keystore / `EncryptedSharedPreferences` for private Ed25519 keys and UUID.
  2. Dynamic endpoint manager supporting primary Cloudflare HTTPS/WSS URL and backup Cloud Run DR URL.
  3. Deep link handler (`spaas://pair?code=...&primary=...&backup=...`) and dynamic SVG QR code in Web Console.
  4. Adaptive heartbeat with exponential backoff and Wi-Fi/cellular network transition recovery.
  5. Fleet management controls: rename, pause/resume, drain, revoke, and remove.
- **Architecture Changes:** Dynamic dual-endpoint discovery in Kotlin client; elimination of hardcoded LAN fallbacks.
- **Acceptance Gates:** S3-G1 (Device survives `am force-stop` and reconnects with identical keypair), S3-G2 (Deep link automatically configures both endpoints), S3-G3 (Revocation invalidates node access).
- **Regression Tests:** Gate G14B, Gate G15, Android unit tests (`WasmComputeTest.kt`).
- **Rollback Procedure:** Revert `ComputeWorkerClient.kt` changes; fall back to single endpoint pairing.
- **Cost Estimate:** $0.00.

---

### Sprint 4: Empirical Qualification, Intelligent Scheduling & Genuine WASM Execution
- **Objective:** Eliminate simulation shortcuts in Android WASM execution, implement genuine microbenchmarks, and deploy transparent multi-objective scheduling.
- **Deliverables:**
  1. Enhanced Android `WasmRuntimeEngine.kt`: deterministic stack machine interpreter executing WebAssembly opcodes (arithmetic, control flow, linear memory) with strict fuel metering and stdout capture.
  2. Empirical microbenchmarks for Android and Desktop: CPU integer MIPS, FP MFLOPS, WASM fuel rate, RAM bandwidth, network RTT.
  3. Transparent accelerator labeling: `UNTESTED` unless proven with active compute shader dispatch.
  4. Workload scheduler with hard eligibility constraints, multi-attribute Pareto ranking, and "Why This Device?" explanation breakdown.
  5. Real-time Android owner safety controls: in-flight compute cancellation on low battery, charging unplug, or thermal threshold breach.
- **Architecture Changes:** Full deterministic WebAssembly VM in Kotlin; capability vectors embedded in device state.
- **Acceptance Gates:** S4-G1 (Android produces identical SHA-256 digest to Rust `wasmi` for catalog workloads), S4-G2 (Unproved accelerators labeled `UNTESTED`), S4-G3 (10,000-node scheduler benchmark completes in < 5ms).
- **Regression Tests:** Gate G05, Gate G09, Gate G16, Gate G17, Gate G19.
- **Rollback Procedure:** Revert to data-segment parsing VM in `WasmRuntimeEngine.kt`.
- **Cost Estimate:** $0.00.

---

### Sprint 5: Web Console & Android Visual Overhaul, Real Data & Transparent Test Credits
- **Objective:** Redesign the Web Console and Android UI to deliver a cohesive, intuitive experience with pure production telemetry, zero fake data, and transparent double-entry accounting.
- **Deliverables:**
  1. Web Console Redesign across 6 core views:
     - **Overview:** Cluster health, real registered devices, active jobs, guided workflows.
     - **Devices:** Interactive fleet table, hardware badges, qualification profiles, live actions.
     - **Workloads:** Visual catalog (Hashing, Matrix, Compression, Primes), manifest editor, Ed25519 signing studio.
     - **Jobs:** 11-step lifecycle timeline, "Why This Device?" explainability, stdout/stderr viewer.
     - **Usage/Credits:** Auditable double-entry ledger, itemized tariffs, fuel-to-credit formula breakdown.
     - **Administration:** Primary Cloudflare vs Backup Cloud Run health, DR failover trigger, simulation purge.
  2. Android Node Redesign: Home, Performance gauges, Controls sliders, Activity log, Credits ledger, Security keys.
  3. Elimination of synthetic nodes from normal production views; isolated simulation namespace.
- **Architecture Changes:** Addition of Administration domain in Web Console; pure production telemetry default.
- **Acceptance Gates:** S5-G1 (Vite production build with zero warnings), S5-G2 (All displayed buttons perform real actions), S5-G3 (Zero synthetic nodes displayed when simulation is off).
- **Regression Tests:** Gate G12 (Browser Playwright automation), Gate G10 (Ledger idempotency).
- **Rollback Procedure:** Revert `apps/web-console/src/` to previous Vite bundle.
- **Cost Estimate:** $0.00.

---

### Sprint 6: Google Cloud Run Cold Standby, Controlled Failover & Split-Brain Prevention
- **Objective:** Implement the disaster recovery control plane on Google Cloud Run with dormant standby state, control-plane epoch fencing, and verified failback.
- **Deliverables:**
  1. `apps/control-plane` DR Mode:
     - Standby role configuration (`SPAAS_ROLE=STANDBY`): rejects job scheduling and credit settlement, returns HTTP 412/503.
     - Authenticated checkpoint ingestion endpoint (`POST /api/v1/dr/checkpoint`).
     - Operator-approved activation endpoint (`POST /api/v1/dr/activate` with authorization token).
     - Control-plane epoch counter (Epoch 1 = Cloudflare, Epoch 2 = Cloud Run) and fencing tokens in job leases.
  2. Independent standby web console served directly from Cloud Run origin to guarantee access during Cloudflare outages.
  3. Controlled failback synchronization script (`scripts/dr-failback.ps1`) to reconcile state back to Cloudflare SQLite DO.
  4. Dockerfile optimization for Google Cloud Run (`min-instances: 0`, port 8080).
- **Architecture Changes:** Dual control plane support with epoch-based fencing and zero simultaneous scheduling.
- **Acceptance Gates:** S6-G1 (Standby mode rejects write operations), S6-G2 (Activation increments epoch and accepts jobs), S6-G3 (Old leases from previous epoch are fenced and rejected).
- **Regression Tests:** Integration test `test_disaster_recovery_epoch_fencing`, Gate G06.
- **Rollback Procedure:** Re-demote Cloud Run to Standby; reactivate Cloudflare Primary.
- **Cost Estimate:** $0.00 (Cloud Run Free Tier: 2M requests/mo, 360,000 vCPU-seconds, 0 min instances).

---

### Sprint 7: Security Hardening, Scale Verification, Observability & Free-Tier Budget Defense
- **Objective:** Conduct security audits, benchmark high-concurrency node scheduling, implement distributed observability, and enforce strict cost ceilings.
- **Deliverables:**
  1. Cryptographic and security audit:
     - Workload signature verification, replay protection with monotonic nonces, path traversal guards.
     - Android Keystore cryptographic key rotation and revocation tests.
  2. 10,000-Node Scale Benchmark:
     - Validate scheduler throughput, memory footprint, and fairness under concurrent job submissions.
  3. Observability & SRE:
     - Distributed trace correlation IDs across Web, Worker, and Android client.
     - Cloudflare Analytics Engine metrics and Cloud Run structured JSON logs.
  4. Cost & Quota Defense:
     - Measure actual Worker CPU duration (<10ms per request) and DO SQLite storage (<50MB).
     - Operational alarms alerting if monthly free-tier usage exceeds 80%.
- **Architecture Changes:** Addition of distributed correlation headers and cost quota watchdog.
- **Acceptance Gates:** S7-G1 (Adversarial security test suite passes 100%), S7-G2 (10,000 node scheduler latency p95 < 2ms), S7-G3 (Zero cost incurrence under test load).
- **Regression Tests:** Gate G04, Gate G05, Gate G16, Gate G20.
- **Rollback Procedure:** Tune rate limiting RPS down; disable non-critical telemetry streams.
- **Cost Estimate:** $0.00.

---

### Sprint 8: Full Regression Battery, Hardware Acceptance & Final Production Certification
- **Objective:** Execute the entire end-to-end regression battery across emulators and physical devices, package production release artifacts, and certify production readiness.
- **Deliverables:**
  1. Automated 22-Gate Acceptance Suite (`scripts/acceptance.ps1 -Full` and `scripts/acceptance.sh --full`).
  2. Physical Android Hardware Acceptance Harness (`scripts/physical-android-acceptance.ps1`).
  3. Standalone Desktop Worker Runner (`dist/bin/spaas-desktop-worker.ps1`).
  4. Production Release Distribution (`dist/`):
     - Signed Android APK (`SPaaS-Node-v0.1.0.apk`) with SHA-256 and APK Signature Scheme v2.
     - Release binaries for Linux, Windows, macOS.
     - SBOM (Software Bill of Materials) and checksums (`dist/checksums.json`).
  5. Final Production Certification Report (`acceptance-report.json`) with honest classifications (`PROVEN`, `PHYSICAL-DEVICE-PROVEN`, `SIMULATION-PROVEN`, `HARDWARE-REQUIRED`).
- **Architecture Changes:** Final artifact packaging and release signing.
- **Acceptance Gates:** S8-G1 (100% pass on all 22 behavioral gates), S8-G2 (Physical device executes challenge and verifies receipt), S8-G3 (Zero unclassified or skipped gates).
- **Regression Tests:** All workspace unit, integration, and security tests.
- **Rollback Procedure:** N/A (Release tagging).
- **Cost Estimate:** $0.00.

---

## 3. Sprint Execution Schedule & Dependencies

```
[Sprint 1: Forensic Audit & ADRs]
       │
       ▼
[Sprint 2: Cloudflare Worker DO] ───► [Sprint 6: Cloud Run Standby DR]
       │                                       │
       ▼                                       │
[Sprint 3: Remote Mobile Onboarding]           │
       │                                       │
       ▼                                       │
[Sprint 4: Genuine WASM & Qualification]       │
       │                                       │
       ▼                                       │
[Sprint 5: UX Overhaul & Test Credits] ────────┘
       │
       ▼
[Sprint 7: Security, Scale & Cost Quotas]
       │
       ▼
[Sprint 8: Full Regression & Certification]
```

Every sprint produces a working, integrated, and independently testable increment.
