# SPaaS — Implementation Plan (Post-Audit)

**Based on:** Independent forensic gap analysis of commit `8528155`  
**Created:** 2026-09-27  
**Total Gaps:** 5 BLOCKER, 7 CRITICAL, 9 MAJOR, 6 MINOR (27 total)  
**Estimated Total Effort:** 35-45 engineering days across 7 sprints

---

## Sprint Dependency Order

S1 (Audit) → S2 (Cloudflare Deploy) → S3 (Physical Devices & WASM) + S4 (Scheduler/UX) → S5 (Cloud Run DR) → S6 (Security/Observability) → S7 (Acceptance)

---

## S1 — Independent Forensic Audit & Traceability ✅ COMPLETE

**Deliverables:**
- [x] `GAP_ANALYSIS.md` — Corrected from inflated 31/31 to audited 17/14/1/1
- [x] `REQUIREMENTS_TRACEABILITY.md` — Downgraded 17 requirements with evidence
- [x] `IMPLEMENTATION_PLAN.md` — This document
- [x] Prioritized gap register with 27 items across 7 sprints

---

## S2 — Real Cloudflare Deployment, API Integration & Security ✅ COMPLETE

**Objective:** Deploy a functioning public Cloudflare Worker + Pages with authenticated API, realistic DO testing, and production secrets.

**Gaps Addressed:** GAP-B01, GAP-C01, GAP-C02, GAP-C03, GAP-C05, GAP-M07, GAP-M08, GAP-M09

### Work Items

| # | Task | Files | Status |
|---|---|---|---|
| S2-01 | Add authentication middleware to CF Worker. Validate `Authorization: Bearer <token>` on mutating routes. | `coordinator.js`, `index.js` | ✅ Complete |
| S2-02 | Add rate limiting. Per-IP request counting with configurable RPS. Return 429 on breach. | `coordinator.js` | ✅ Complete |
| S2-03 | Replace in-memory mock tests with SQLite storage bridge. Exercise SQL persistence, WebSocket, and alarms. | `sqlite-bridge.js`, `tests/*` | ✅ Complete |
| S2-04 | Remove `continue-on-error` from CI. Add post-deploy health check. | `.github/workflows/ci.yml` | ✅ Complete |
| S2-05 | Podman containerized test runner with 14/14 passing tests and 91.29% coverage. | Podman, `package.json` | ✅ Complete |
| S2-06 | Configure web console API URL via `VITE_API_URL`. Remove hardcoded localhost. | `main.js`, `vite.config.js` | ✅ Complete |
| S2-07 | Add coverage reporting to CI with ≥90% threshold. | `.github/workflows/ci.yml`, `package.json` | ✅ Complete |

**Acceptance:** Public Worker URL returns healthy; unauthenticated POST returns 401; Pages loads and connects; 14/14 automated tests pass with 91.29% measured coverage.

---

## S3 — Physical Device Onboarding & Genuine WASM Execution

**Objective:** Enroll real Android devices over the internet and execute genuine WASM bytecode.

**Gaps Addressed:** GAP-B02, GAP-B03, GAP-C05, GAP-M03, GAP-M04

### Work Items

| # | Task | Files | Effort |
|---|---|---|---|
| S3-01 | Replace WasmRuntimeEngine with genuine WASM interpreter (Chicory/wasmi-jni/minimal VM). Must execute actual `.wasm` binary opcodes. | `WasmRuntimeEngine.kt` | 5-7 days |
| S3-02 | Implement WASM binary delivery. Worker stores in `workloads` table; devices download via API. | `coordinator.js`, `ComputeWorkerClient.kt` | 1-2 days |
| S3-03 | Migrate identity to EncryptedSharedPreferences. | `ComputeWorkerClient.kt`, `build.gradle.kts` | 1 day |
| S3-04 | Implement WebSocket client on Android for push-based dispatch. | `ComputeWorkerClient.kt` | 2 days |
| S3-05 | Update deep link to use live Worker URL. Add QR generation in web console. | `MainActivity.kt`, web console | 1 day |
| S3-06 | Physical device acceptance on ≥2 phones with evidence capture. | Physical devices | 1-2 days |

**Acceptance:** Arbitrary WASM binaries execute on Android matching Rust `wasmi` output; ≥2 physical devices enrolled and working.

---

## S4 — Scheduler, Credits, UX & Result Verification

**Objective:** Port Rust scheduler quality to CF Worker, implement usage-based credits, create browser E2E tests.

**Gaps Addressed:** GAP-M01, GAP-M02, GAP-C04, GAP-C07, GAP-N03

### Work Items

| # | Task | Files | Effort |
|---|---|---|---|
| S4-01 | Port multi-attribute scheduler to CF Worker. Score by CPU, memory, RTT, thermals, battery. | `coordinator.js` | 2 days |
| S4-02 | Implement usage-based credit calculation. Remove hardcoded 50.0. True double-entry. | `coordinator.js` | 1 day |
| S4-03 | Create Playwright E2E test suite. Cover enrollment, submission, dashboard, credits. | `apps/web-console/tests/e2e/*` | 2-3 days |
| S4-04 | Add QR code generation to web console. | `apps/web-console/src/main.js` | 0.5 day |
| S4-05 | Build multi-cloud admin dashboard. Live health, epoch, checkpoint age, costs. | `apps/web-console/` | 2 days |
| S4-06 | Wire Pause/Resume/Drain/Emergency Stop UI buttons. | `apps/web-console/src/main.js` | 1 day |

**Acceptance:** CF Worker scheduling uses real capabilities; credits based on actual usage; Playwright tests pass.

---

## S5 — Cloud Run Deployment, Checkpoint Replication & Failover

**Objective:** Deploy CR standby, implement cross-cloud state sync, test real failover/failback.

**Gaps Addressed:** GAP-B04, GAP-B05, GAP-C06, GAP-M05, GAP-M06, GAP-M08

### Work Items

| # | Task | Files | Effort |
|---|---|---|---|
| S5-01 | Build and push container image to Artifact Registry. | `Containerfile.control-plane`, CI | 1 day |
| S5-02 | Deploy Cloud Run service. Verify health endpoint. Verify min-instances: 0. | `deploy/cloud-run/` | 1 day |
| S5-03 | Implement checkpoint ingestion in Rust control plane. | `handlers.rs` | 1-2 days |
| S5-04 | Implement epoch handoff protocol with signed fencing tokens. | `coordinator.js`, `handlers.rs` | 2-3 days |
| S5-05 | Implement recovery frontend served from Cloud Run. | `router.rs` | 1-2 days |
| S5-06 | Test real failover: disable Worker, verify device switchover, job execution on CR, failback. | Integration tests | 2 days |
| S5-07 | Add Cloud Run CI validation: build container, health check, verify standby rejects jobs. | CI | 1 day |

**Acceptance:** Cloud Run deployed at zero cost; failover tested with evidence; no duplicate settlements.

---

## S6 — Security Hardening, Observability & Performance

**Gaps Addressed:** GAP-N01, GAP-N04, GAP-N06, remaining security items

### Work Items

| # | Task | Effort |
|---|---|---|
| S6-01 | Restrict CORS to known origins | 0.5 day |
| S6-02 | Add JSON input validation on all routes | 1 day |
| S6-03 | Implement credential rotation endpoint | 1 day |
| S6-04 | Generate SBOM in CI | 0.5 day |
| S6-05 | Write operational runbooks | 1 day |
| S6-06 | Benchmark scheduler at 100/1K/5K/10K nodes | 1 day |
| S6-07 | Measure and document actual cloud costs | 0.5 day |
| S6-08 | Add monitoring, structured logging, correlation IDs | 1 day |

---

## S7 — Comprehensive Regression, Cross-Cloud E2E & Certification

### Work Items

| # | Task | Effort |
|---|---|---|
| S7-01 | Fix acceptance script classification logic (remove auto-PROVEN) | 0.5 day |
| S7-02 | Run full cross-cloud E2E test from clean environment | 2 days |
| S7-03 | Generate final acceptance report with honest evidence classifications | 1 day |
| S7-04 | Update all documentation | 1 day |
| S7-05 | Release packaging: tag, checksums, APK, artifacts | 0.5 day |
| S7-06 | Publish limitations and roadmap | 0.5 day |

---

## Effort Summary

| Sprint | Focus | Gaps | Days |
|---|---|---|---|
| S1 | Audit & Traceability | Audit | ✅ Done |
| S2 | Cloudflare Deployment | 7 | 5-6 |
| S3 | Physical Devices & WASM | 5 | 10-13 |
| S4 | Scheduler, Credits & UX | 6 | 8-10 |
| S5 | Cloud Run DR | 6 | 9-12 |
| S6 | Security & Observability | 5 | 6-7 |
| S7 | Acceptance & Certification | Final | 5-6 |
| **Total** | | **27 gaps** | **~43-54 days** |
