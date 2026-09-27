# SPaaS Universal Edge Compute Fabric — Implementation Plan

**Document Version:** 5.0.0  
**Author:** Principal Distributed Systems Architect  
**Execution Horizon:** 7 Deployable Sprints with Strict Verification Gates  
**Reference:** [GAP_ANALYSIS.md](file:///h:/SpaaS/GAP_ANALYSIS.md), [REQUIREMENTS_TRACEABILITY.md](file:///h:/SpaaS/REQUIREMENTS_TRACEABILITY.md)

---

## Sprint Overview

| Sprint | Focus | Blockers Resolved | Estimated Effort |
|---|---|---|---|
| S1 | Forensic audit, defect reproduction, requirements traceability | — | COMPLETE |
| S2 | Fix Cloudflare connectivity, LAN onboarding, universal enrollment | GAP-B01, GAP-B07, GAP-C02, GAP-C06 | HIGH |
| S3 | Cross-platform workers: Windows/Linux/macOS binaries + iOS client | GAP-B06, GAP-C05 | HIGH |
| S4 | Genuine benchmarking, WASM execution, intelligent scheduling | GAP-B02, GAP-B03 | HIGH |
| S5 | Visual overhaul, fleet management, telemetry, TEST CREDIT accounting | GAP-M05, GAP-M06 | MEDIUM |
| S6 | Cloudflare hardening + Cloud Run backup, DR, epoch fencing | GAP-B04, GAP-B05, GAP-M03, GAP-M04 | HIGH |
| S7 | Security, performance, cost, resilience testing, certification | GAP-C03, GAP-C07 | MEDIUM |

---

## Sprint 1: Forensic Audit & Requirements Traceability (COMPLETE)

### Deliverables
1. ✅ `GAP_ANALYSIS.md` v5.0.0 — 7 BLOCKER, 7 CRITICAL, 8 MAJOR, 5 MINOR gaps identified
2. ✅ `REQUIREMENTS_TRACEABILITY.md` v5.0.0 — 37 requirements mapped: 17 COMPLETE, 11 PARTIAL, 5 BROKEN, 4 MISSING
3. ✅ `IMPLEMENTATION_PLAN.md` v5.0.0 — This document
4. ✅ Full workspace verification: `cargo check`, `cargo test --workspace`, `cargo fmt --check`, `cargo clippy`, all passing

### Acceptance Gates
- S1-G1: GAP_ANALYSIS.md published with reproducible audit evidence commands ✅
- S1-G2: REQUIREMENTS_TRACEABILITY.md covers all 10 domains ✅
- S1-G3: Existing 64 tests continue passing with 0 regressions ✅

---

## Sprint 2: Fix Cloudflare Connectivity & Universal Enrollment

### Objective
Eliminate all hardcoded LAN/localhost addresses from the production web console. Implement a universal enrollment wizard that works over the public internet via the Cloudflare Worker backend. Remove hardcoded admin secrets. Fix CF coordinator scheduling.

### Gaps Resolved
- **GAP-B01:** Web console hardcodes LAN addresses → Replace with dynamic API discovery
- **GAP-B07:** Hardcoded admin secret → Remove fallbacks, require env var
- **GAP-C02:** CF scheduler is FIFO → Port multi-attribute scoring
- **GAP-C06:** CORS wildcard → Restrict to known origins
- **GAP-M05:** No QR code → Generate real QR via qrcode.js or SVG generation

### File-Level Changes

#### `apps/web-console/src/main.js`
- Remove `spaas_production_admin_secret_2026` fallback (line 6)
- Refactor `getApiBase()` to never fall back to `127.0.0.1:8080` (lines 46-56)
- Remove all localhost/LAN references from UI generation code
- Add actual QR code generation using inline SVG QR encoder
- Add enrollment token flow: request token from backend → display QR → poll for completion

#### `apps/web-console/index.html`
- Remove "Host Network Reachability & Host LAN IP" card (lines 1319-1386)
- Remove `192.168.0.111` references (lines 1336, 1346)
- Remove `127.0.0.1` references from sidebar (line 58), admin panel, diagnostics
- Remove "Download 1-Click Firewall Fix (.bat)" button (line 1370)
- Replace LAN onboarding flow with universal enrollment wizard:
  - Step 1: Select platform (Android / iOS / Desktop)
  - Step 2: Install app / Download binary
  - Step 3: Scan QR code or enter pairing code
  - Step 4: Approve device on dashboard
  - Step 5: Device benchmarks and becomes Ready

#### `apps/cloudflare-control-plane/src/coordinator.js`
- Remove hardcoded admin secret fallback (line 15) — require `SPAAS_API_SECRET` env var
- Refactor `schedulePendingJobs()` — implement capability scoring instead of `readyNodes.shift()`
- Restrict CORS to `*.pages.dev` and `localhost` origins

#### `apps/cloudflare-control-plane/wrangler.toml`
- Add `SPAAS_API_SECRET` to required env/secrets

### Acceptance Gates
- S2-G1: `grep -rn "192.168" apps/web-console/` returns 0 results
- S2-G2: `grep -rn "spaas_production_admin_secret" apps/` returns 0 results
- S2-G3: Web console production build connects to Cloudflare Worker without manual IP entry
- S2-G4: Enrollment generates real QR code scannable by a camera app

### Rollback
- Revert web console changes; restore `getApiBase()` fallback behavior

### Cost: $0.00 (Cloudflare free tier)

---

## Sprint 3: Cross-Platform Workers & iOS Client

### Objective
Create standalone native Rust worker binaries for Windows, Linux, macOS with platform-specific packaging. Create a minimal iOS Swift worker with honest platform limitation documentation.

### Gaps Resolved
- **GAP-B06:** No iOS client → Create minimal Swift app with Keychain identity
- **GAP-C05:** No desktop worker package → Create standalone binaries

### File-Level Changes

#### New: `apps/ios-node/` (Swift Xcode project)
- `SPaaSNode/SPaaSNodeApp.swift` — App entry point
- `SPaaSNode/EnrollmentView.swift` — QR scanner + pairing code enrollment
- `SPaaSNode/WorkerService.swift` — Background task execution (limited by iOS restrictions)
- `SPaaSNode/KeychainIdentity.swift` — Secure Enclave / Keychain Ed25519 key storage
- `SPaaSNode/WasmEngine.swift` — Embed `WasmKit` or `JavaScriptCore` for WASM execution
- `SPaaSNode/PLATFORM_LIMITATIONS.md` — Honest documentation of iOS background execution restrictions

#### New: `apps/desktop-worker/` (Rust binary)
- `src/main.rs` — CLI worker with enrollment, heartbeat, job execution, and result upload
- `src/enrollment.rs` — Pairing code / QR enrollment flow
- `src/identity.rs` — Platform-specific keychain/credential storage
- `src/config.rs` — TOML configuration file
- `Cargo.toml` — Binary crate depending on `spaas-node-agent`, `spaas-runtime`, `spaas-security`

#### Updated: `.github/workflows/ci.yml`
- Add desktop worker build matrix (Linux x86_64, Windows x86_64, macOS ARM64)
- Add iOS build step (macOS runner, `xcodebuild`)

### Acceptance Gates
- S3-G1: `cargo build -p spaas-desktop-worker` succeeds on Windows
- S3-G2: Desktop worker enrolls with Cloudflare backend via pairing code
- S3-G3: iOS project compiles with `xcodebuild` (requires macOS runner)
- S3-G4: Platform limitations documented in PLATFORM_LIMITATIONS.md

### Cost: $0.00

---

## Sprint 4: Genuine Benchmarking, WASM Execution & Scheduling

### Objective
Fix Android WASM execution to use genuine bytecode interpretation. Implement versioned cross-platform benchmark specification. Fix acceptance gate G14B.

### Gaps Resolved
- **GAP-B02:** Android WASM not genuine → Integrate real WASM interpreter
- **GAP-B03:** Physical device proof fabricated → Fix acceptance filter

### File-Level Changes

#### `apps/android-node/app/src/main/java/dev/spaas/node/service/WasmRuntimeEngine.kt`
- Replace native Kotlin algorithm dispatch (lines 148-253) with actual WASM stack machine VM
- Options: Integrate `Chicory` (pure Java WASM runtime), or `wasm3` via JNI
- Keep fuel metering and WASI output capture
- Validate output matches Rust `wasmi` for identical inputs

#### `scripts/acceptance.ps1` (G14B)
- Fix filter to require `device_type -eq "android_smartphone"` AND `capabilities.architecture -match "arm"` AND ADB serial verification
- Never classify desktop workers as physical Android devices

#### New: `crates/benchmark-spec/` (shared benchmark definition)
- Versioned benchmark specification: CPU, memory, WASM fuel rate
- Platform-specific measurement adapters (Rust, Kotlin, Swift)

### Acceptance Gates
- S4-G1: Android `WasmRuntimeEngine` produces identical SHA-256 digest to Rust `wasmi` for catalog workloads
- S4-G2: Gate G14B only classifies as PHYSICAL-DEVICE-PROVEN when ADB confirms physical ARM device
- S4-G3: Benchmark specification versioned and serializable

### Cost: $0.00

---

## Sprint 5: Visual Overhaul & TEST CREDIT Accounting

### Objective
Redesign web console for Cloudflare-first architecture. Implement real QR codes, fleet management, transparent double-entry TEST CREDIT ledger.

### Gaps Resolved
- **GAP-M06:** Not true double-entry → Implement paired debit/credit entries

### File-Level Changes

#### `apps/web-console/index.html` + `src/main.js`
- Modernize enrollment wizard (no LAN references)
- Real QR code rendering with actual pairing URI
- Fleet grouping, device comparison views
- Job timeline with "Why This Device?" explainability
- Double-entry ledger view with debit/credit pairs
- Multi-cloud status indicator

#### `apps/cloudflare-control-plane/src/coordinator.js`
- Implement paired debit/credit ledger entries per settlement
- Add downloadable ledger history endpoint

### Acceptance Gates
- S5-G1: Vite production build zero warnings
- S5-G2: All buttons perform real actions (no stubs)
- S5-G3: Ledger shows paired debit/credit entries

### Cost: $0.00

---

## Sprint 6: Cloudflare Hardening & Cloud Run DR

### Objective
Deploy genuine Cloud Run standby. Implement cross-cloud epoch synchronization. Prove failover and failback.

### Gaps Resolved
- **GAP-B04:** No Cloud Run deployment → Actually deploy
- **GAP-B05:** No epoch synchronization → Implement signed fencing protocol
- **GAP-M03:** No failback → Implement state reconciliation
- **GAP-M04:** No DR frontend → Serve web console from Cloud Run origin

### File-Level Changes

#### `deploy/cloud-run/deploy-cloud-run.ps1`
- Replace `Write-Host` with actual `gcloud` command execution
- Add health check validation after deployment

#### `apps/control-plane/src/handlers.rs`
- Add epoch handoff endpoint: `POST /api/v1/dr/epoch-handoff`
- Validate fencing tokens against Cloudflare checkpoint source

#### `apps/cloudflare-control-plane/src/coordinator.js`
- Add `POST /api/v1/dr/epoch-handoff` for cross-cloud epoch exchange
- Include signed fencing token in checkpoint exports

#### New: `scripts/dr-failback.ps1`
- Reconcile Cloud Run state back to Cloudflare DO
- Validate epoch monotonicity before failback

### Acceptance Gates
- S6-G1: Cloud Run service deploys with `min-instances: 0`
- S6-G2: Standby rejects write operations (HTTP 412)
- S6-G3: Activation increments epoch and accepts jobs
- S6-G4: Failback reconciles state without data loss

### Cost: $0.00 (Cloud Run free tier: 2M req/mo, 360K vCPU-s)

---

## Sprint 7: Security, Testing & Production Certification

### Objective
Comprehensive security audit, E2E browser testing, coverage enforcement, and honest production certification.

### Gaps Resolved
- **GAP-C03:** No browser tests → Playwright suite
- **GAP-C07:** Coverage unreproducible → Integrate instrumentation

### File-Level Changes

#### New: `tests/e2e/` (Playwright)
- `enrollment.spec.ts` — Enrollment wizard flow
- `job-submission.spec.ts` — Job submission and monitoring
- `dashboard.spec.ts` — All 6 tabs render correctly

#### `.github/workflows/ci.yml`
- Add cargo-tarpaulin coverage step
- Add Playwright test step
- Fail on coverage below 90%

#### `scripts/acceptance.ps1`
- Fix Gate G03 to require actual measured coverage (not stale file)
- Fix Gate N01: require explicit classification output from every gate

### Acceptance Gates
- S7-G1: Playwright tests pass covering enrollment, job submission, dashboard
- S7-G2: Measured coverage ≥ 90% via cargo-tarpaulin
- S7-G3: No hardcoded secrets in source code
- S7-G4: All 22 gates pass with honest classifications

### Final Certification
- Every capability classified honestly: PROVEN, PHYSICAL-DEVICE-PROVEN, EMULATOR-PROVEN, SIMULATION-PROVEN, IMPLEMENTED-UNPROVEN, HARDWARE-REQUIRED, UNSUPPORTED, or FAILED
- No skipped tests counted as passing
- No fabricated metrics or simulated production claims

### Cost: $0.00

---

## Sprint Dependencies

```
[S1: Forensic Audit] ✅ COMPLETE
       │
       ▼
[S2: Cloudflare Connectivity & Enrollment]
       │                    │
       ▼                    ▼
[S3: Cross-Platform]    [S5: Visual Overhaul]
       │                    │
       ▼                    │
[S4: WASM & Benchmarks]    │
       │                    │
       ▼                    ▼
[S6: Cloud Run DR & Epoch Fencing]
       │
       ▼
[S7: Security, Testing & Certification]
```

Every sprint produces working, integrated, and independently testable features. The application must remain deployable after every iteration.
