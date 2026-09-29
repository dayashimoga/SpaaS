# SPaaS Universal Edge Compute Fabric — Authoritative Implementation Plan
## Production-Grade Heterogeneous Edge Compute Pipeline & UX Overhaul

**Document Version:** 7.0.0  
**Status:** READY FOR EXECUTION  
**Target:** Cloudflare Pages + Workers + SQLite Durable Objects (Primary) ↔ Cloud Run / Rust (DR) ↔ Physical Android / Desktop / iOS Workers  
**Author:** Principal Distributed Systems, Cloudflare DO, WASM/GPU-AI, Android/Kotlin, Rust, Security & Product UX Architect  

---

## 1. Architectural Baseline & Principles

SPaaS coordinates voluntary compute provision across mobile, desktop, and edge hardware:
- **Primary Control Plane:** Cloudflare Worker (`apps/cloudflare-control-plane/src/index.js`) + Durable Object SQLite (`coordinator.js`, `sqlite-bridge.js`) at `https://spaas-control-plane.dayashimoga.workers.dev`.
- **Primary Web Console:** Cloudflare Pages at `https://spaas-console.pages.dev` (built from `apps/web-console`).
- **Disaster Recovery (Cold Standby):** Google Cloud Run Rust Control Plane (`apps/control-plane`) with epoch fencing.
- **Physical Mobile Worker:** Android App (`apps/android-node`, package `dev.spaas.node`), executing sandboxed WASM stack machine via `WasmRuntimeEngine.kt` on ARM64.
- **Desktop Worker:** Rust Native Daemon (`apps/desktop-worker`, `crates/workload-runtime`) with `wasmi` WASI preview 1.
- **Evidence Label Standard:** ONLY `PROVEN`, `PHYSICAL-DEVICE-PROVEN`, `EMULATOR-PROVEN`, `SIMULATION-PROVEN`, `IMPLEMENTED-UNPROVEN`, `HARDWARE-REQUIRED`, `UNSUPPORTED`. Zero mocks or fabricated benchmarks.

```
+-------------------------------------------------------------------------------------------------------+
|                                          SPaaS Edge Fabric Architecture                               |
+-------------------------------------------------------------------------------------------------------+
|                                                                                                       |
|  CONSUMERS / WEB CONSOLE (spaas-console.pages.dev)                                                    |
|  - Progressive Disclosure: Simple Mode (Wizard) vs Advanced (YAML, Fuel, Leases)                     |
|  - Realtime SSE / Polling Fallback ↔ Convergence                                                     |
|                                     │                                                                 |
|                                     ▼                                                                 |
|  CLOUDFLARE INGRESS GATEWAY (index.js)                                                                |
|  - CORS, Rate Limiting (Token Bucket), Security Headers, APK Downloads                                |
|                                     │                                                                 |
|                                     ▼                                                                 |
|  AUTHORITATIVE DURABLE OBJECT + SQLITE (coordinator.js)                                               |
|  - Authoritative State Machine (12 States + 5 Failure States)                                         |
|  - Capability-Aware Pareto Scheduler ("Why selected / excluded?")                                    |
|  - Single-use Pairing Tokens, Device Auth, Fencing Tokens, Leases, Double-Entry Ledger                |
|  - WebSocket Hibernation API + Fallback Polling (`/heartbeat`, `/poll`)                              |
|                                     │                                                                 |
|         ┌───────────────────────────┴───────────────────────────┐                                     |
|         ▼                                                       ▼                                     |
|  PHYSICAL ANDROID WORKER (dev.spaas.node)             DESKTOP / EDGE DAEMON (Rust)                    |
|  - 6-Tab Architecture:                                - Native CLI / Daemon                           |
|    Home / Jobs / Performance / Controls /             - `wasmi` WASI Preview 1 Sandbox                |
|    Earnings / Security                                - Ed25519 Result Attestation                    |
|  - Provider Policy (Auto / Ask Me / Paused)           - Hardware Probing                              |
|  - Sandboxed WASM Stack Machine (WasmRuntimeEngine)                                                   |
|  - Ed25519 Result Attestation                                                                        |
|                                                                                                       |
+-------------------------------------------------------------------------------------------------------+
```

---

## 2. Forensic Audit & Root Cause Analysis of Active Gaps

| Gap ID | Symptom / Failure | Boundary & Offending File | Root Cause Mechanism | Evidence / Screenshot Reference | Planned Fix |
|---|---|---|---|---|---|
| **GAP-01** | `Submission failed: mode is not defined` red banner in Web Console | `apps/web-console/src/main.js` (line 390) | In `setConnectionState(newState, reason)`, line 390 evaluated `mode === 'UNCONFIGURED'`. `mode` is undeclared (should be `newState`). When `submitCurrentWorkload()` called `await refreshAllData()` after POST `/jobs`, this ReferenceError was caught, displaying a failure toast even though the job was created. | Screenshot 1 (`mode is not defined`) | Replace `mode === 'UNCONFIGURED'` with `newState === 'UNCONFIGURED'`. |
| **GAP-02** | Generic workload (`edge-matrix-multiplication`) stuck in `DISPATCHED` | `coordinator.js` (line 1675-1707) ↔ `ComputeWorkerClient.kt` (line 610-664) | 1. In `coordinator.js` `/poll`, `wasm_bytes` was set to `wasmBytes` which parsed as `null` for base64 strings.<br>2. `spec.artifact_uri` was `'inline://wasm'`, but the server only injected data URI if `artifact_uri === ""`.<br>3. Android received no base64 and non-data URI, falling into the 48-byte stub.<br>4. Android computed SHA-256 of the 48-byte stub, which mismatched the real Matrix WASM SHA-256 recorded on the server.<br>5. Android threw `IllegalStateException`, which was caught and swallowed by `executeJobPayload` without sending a failure receipt to the server. | Screenshot 3 (`edge-matrix-multiplication DISPATCHED`) | 1. Pass `wasm_bytes` properly and ensure `data:application/wasm;base64,...` is always populated in `artifact_uri`.<br>2. Handle `inline://wasm` on Android.<br>3. Send explicit failure receipt to `/api/v1/nodes/results` on verification error so the server transitions the job to `FAILED` and frees the node. |
| **GAP-03** | Subsequent queued jobs stuck in `QUEUED` | `coordinator.js` (line 483, 639) | When Job 3 was dispatched, `nodes.state` was set to `'Busy'`. Because Job 3 was stuck, the node never transitioned back to `'Ready'`. The scheduler queries `WHERE state = 'Ready'`, finding 0 nodes, leaving Job 1 and Job 2 permanently queued. | Screenshot 3 (2 jobs `QUEUED`, 1 `DISPATCHED`) | Release node state to `'Ready'` on failure, lease expiration, or job cancellation; handle concurrency. |
| **GAP-04** | Fragmented State Machine & Non-Standard States | `coordinator.js` ↔ `main.js` ↔ `ComputeWorkerClient.kt` | States were inconsistent: `Pending`, `Queued`, `Scheduled`, `Running`, `Completed`, `DISPATCHED`, `ACKNOWLEDGED`. Need strict DAG: `SUBMITTED` -> `QUEUED` -> `MATCHING` -> `OFFERED` -> `ASSIGNED` -> `LEASED` -> `DOWNLOADING` -> `EXECUTING` -> `UPLOADING` -> `VERIFYING` -> `COMPLETED` -> `SETTLED`. | Baseline requirement 1 | Implement unified 12-state machine with transitions, timestamps, reasons, and next-action in `job_transitions`. |
| **GAP-05** | Capability Scheduler Lacks Explainability & Pareto Trade-offs | `coordinator.js` (`schedulePendingJobs`) | Scheduling used fixed heuristic weights without checking workload capability requirements (RAM, architecture, thermal headroom, provider policy). Decisions lacked "Why selected / excluded?" breakdowns. | Baseline requirement 3 | Implement capability matching filter + Pareto scoring + transparent rationale explaining candidate exclusions and selection. |
| **GAP-06** | Missing Provider Controls (Auto Accept / Ask Me / Scheduled Auto / Paused) | `apps/android-node` ↔ `apps/web-console` | Provider policies only supported basic battery/charging sliders. No pre-execution "Ask Me" prompt, no schedule windows, no emergency stop button on node. | Baseline requirement 4 | Implement 4 provider modes (Auto Accept, Ask Me, Scheduled Auto, Paused) with interactive prompt on mobile before execution. |
| **GAP-07** | Fleet Management Scalability & Mixed Inventory | `apps/web-console` (`Devices` view) ↔ `coordinator.js` | Bulk select, search, tag filtering, and separation of physical vs simulated nodes were basic. Simulated nodes could contaminate production metrics if not strictly filtered. | Baseline requirement 5 | Add bulk selection, tagging/pools, search/filter, and strict isolation of simulated nodes from production metrics. |
| **GAP-08** | Web Console Complexity & Missing Progressive Disclosure | `apps/web-console` (`index.html`, `main.js`) | Workload submission exposed raw YAML, fuel, memory bytes, and lease parameters by default. Dialogs used `alert()` instead of toasts. Duplicate buttons existed. | Baseline requirement 6 | Overhaul navigation (Overview, Fleet, Workloads, Jobs, Usage & Credits, Administration). Workload Studio wizard with simple mode + Advanced toggle. Replace `alert()`. |
| **GAP-09** | Mobile UX Architecture Needs 6 Distinct Sections | `apps/android-node` (`MainActivity.kt`) | Mobile UI had navigation tabs but lacked granular details in Performance, Controls, and Security; history lacked individual delete and clear all. | Baseline requirement 7 | Align Android tabs: Home, Jobs, Performance, Controls, Earnings, Security with real-time progress and policy controls. |
| **GAP-10** | Generic Workload Verification & Settlement Parity | `coordinator.js` (`handleResultSubmission`) | Verification only checked `expected_digest` for challenge jobs. Generic jobs need execution verification (exit code 0, fuel within bounds, output signature) and identical double-entry ledger settlement. | Baseline requirement 2, 8 | Standardize generic workload verification, output digests, and double-entry settlement across all presets. |

---

## 3. Authoritative State Machine Specification

### 3.1 Lifecycle States & Directed Acyclic Graph (DAG)

```
[SUBMITTED]
    │  Workload validated, spec saved in workloads table
    ▼
[QUEUED]
    │  Enqueued for capability matching
    ▼
[MATCHING]
    │  Scheduler filters candidates (capabilities, policy, battery, thermals)
    ▼
[OFFERED]  <── (Optional: If node provider policy is "ASK ME")
    │  User accepts on device (or automatically bypassed if AUTO_ACCEPT)
    ▼
[ASSIGNED]
    │  Node bound to job in SQLite
    ▼
[LEASED]
    │  Lease minted (fencing token, epoch, 60s lease timer)
    ▼
[DOWNLOADING]
    │  Node fetches artifact URI / base64 and verifies SHA-256
    ▼
[EXECUTING]
    │  Node launches sandboxed WASM stack machine (fuel & memory capped)
    ▼
[UPLOADING]
    │  Node signs result digest and sends HTTP POST /api/v1/nodes/results
    ▼
[VERIFYING]
    │  Server verifies signature, lease, fencing token, output digest
    ▼
[SETTLED]
    │  Double-entry ledger transaction minted (DEBIT consumer, CREDIT provider)
    ▼
[COMPLETED]
    ── Final terminal success state
```

**Failure & Recovery Branches:**
- From `MATCHING`: If no nodes match $\rightarrow$ `QUEUED` with `wait_reason: "NO_CAPABLE_NODES (Waiting for Android aarch64 with >=512MB RAM)"`.
- From `OFFERED`: If provider declines $\rightarrow$ `REJECTED` $\rightarrow$ Re-queued with candidate excluded.
- From `LEASED` / `DOWNLOADING` / `EXECUTING`: If lease timer expires $\rightarrow$ `LEASE_EXPIRED` $\rightarrow$ Node reset to `Ready` $\rightarrow$ Re-queued if retries $< 3$, else `FAILED`.
- From `DOWNLOADING`: If artifact SHA-256 fails $\rightarrow$ `REJECTED (ARTIFACT_CORRUPT)` $\rightarrow$ Node reset to `Ready`.
- From `EXECUTING`: If out of fuel $\rightarrow$ `FAILED (OUT_OF_FUEL)` $\rightarrow$ Settled for fuel consumed, 0 bonus credits.
- From any non-terminal state: Admin cancellation $\rightarrow$ `CANCELLED` $\rightarrow$ Node reset to `Ready`.

### 3.2 Transition Persistence Model (`job_transitions`)
Each transition persists:
- `job_id`: Unique job identifier.
- `from_state`: Prior state.
- `to_state`: New authoritative state.
- `reason`: Human-readable cause (e.g., `"Candidate node selected by Pareto scheduler"`).
- `next_action`: Next expected pipeline action (e.g., `"Awaiting device ACK / download"`).
- `metadata`: JSON payload containing lease ID, fencing token, score breakdown, or error details.
- `timestamp`: UTC millisecond timestamp.

---

## 4. Phase-by-Phase Implementation Blueprint

### Phase 1: Critical Root-Cause Fixes & Deadlock Prevention
- **Files Modified:**
  - `apps/web-console/src/main.js`
  - `apps/cloudflare-control-plane/src/coordinator.js`
  - `apps/android-node/app/src/main/java/dev/spaas/node/service/ComputeWorkerClient.kt`
- **Actions:**
  1. Fix `mode === 'UNCONFIGURED'` in `main.js` line 390 $\rightarrow$ `newState === 'UNCONFIGURED'`.
  2. In `coordinator.js` `/poll` and `/heartbeat`, ensure `wasm_bytes` is returned as a base64 string and `spec.artifact_uri` is always set to `data:application/wasm;base64,...` whenever `wasm_bytes` exists.
  3. In `ComputeWorkerClient.kt`, support `inline://wasm` artifact URIs and decode base64 wasm bytes reliably.
  4. In `ComputeWorkerClient.kt`, wrap artifact validation and execution in explicit failure reporting: if validation fails, send an explicit failure receipt to `/api/v1/nodes/results` with reason `ARTIFACT_HASH_MISMATCH` so the job is marked `FAILED` and the node is freed back to `Ready`.
  5. In `coordinator.js` `alarm()`, ensure any expired lease resets `nodes.state = 'Ready'` immediately.
- **Verification:**
  - Unit test verifying `mode` error resolution.
  - Test `/poll` returns executable payload with valid SHA-256 match.

### Phase 2: Complete Authoritative State Machine & Transition DAG
- **Files Modified:**
  - `apps/cloudflare-control-plane/src/coordinator.js`
  - `apps/cloudflare-control-plane/src/sqlite-bridge.js`
  - `apps/web-console/src/main.js`
- **Actions:**
  1. Update `recordJobTransition` to enforce valid DAG transitions and store `next_action`.
  2. Implement states: `SUBMITTED`, `QUEUED`, `MATCHING`, `OFFERED`, `ASSIGNED`, `LEASED`, `DOWNLOADING`, `EXECUTING`, `UPLOADING`, `VERIFYING`, `SETTLED`, `COMPLETED`.
  3. Expose `wait_reason` in `/api/v1/jobs` when state is `QUEUED`.
  4. Add `/api/v1/jobs/:id/trace` returning the complete chronological lifecycle timeline with timestamps, reasons, and next-actions.
- **Verification:**
  - Automated test creating a job and asserting all transitions are recorded in `job_transitions` without illegal jumps.

### Phase 3: Generic Compute Execution Pipeline (No Verification-Only Special Casing)
- **Files Modified:**
  - `apps/cloudflare-control-plane/src/coordinator.js`
  - `apps/android-node/app/src/main/java/dev/spaas/node/service/ComputeWorkerClient.kt`
  - `apps/android-node/app/src/main/java/dev/spaas/node/service/WasmRuntimeEngine.kt`
  - `apps/web-console/src/main.js`
- **Actions:**
  1. Ensure Hello World, SHA-256 Hasher, Prime Sieve, Matrix Multiplication, and custom uploaded WASM use the exact same submission, placement, dispatch, and settlement pipeline.
  2. Standardize result payload: `stdout`, `stderr`, `exit_code`, `fuel_consumed`, `wall_time_ms`, `peak_memory_bytes`, `result_digest`, `node_signature`.
  3. In `coordinator.js` `handleResultSubmission`:
     - Verify signature using node public key.
     - For deterministic workloads, verify stdout or digest.
     - For general compute, verify exit code 0 and fuel/memory constraints.
     - Award credits via double-entry ledger.
- **Verification:**
  - Automated test running Hello World, SHA-256, Prime Sieve, and Matrix Multiplication through the DO control plane.

### Phase 4: Capability-Aware Scheduler with Pareto Ranking & Explainability
- **Files Modified:**
  - `apps/cloudflare-control-plane/src/coordinator.js`
  - `apps/web-console/src/main.js`
- **Actions:**
  1. Profile candidates on:
     - CPU: Single-thread, multi-thread, WASM fuel MIPS, ISA architecture.
     - Memory: Available RAM, max allocation.
     - Network: RTT ping, downlink bandwidth, network type (Wi-Fi, unmetered, cellular).
     - Power & Thermals: Charging state, battery %, thermal headroom.
     - Reliability: Historical job success rate (0-100%).
  2. Filter: Exclude nodes failing workload requirements (e.g. `min_ram_mb`, `require_charging`, `require_unmetered_network`).
  3. Filter: Enforce provider safety policies (`charging_only`, `min_battery_threshold_pct`, `thermal_cutoff`).
  4. Rank: Compute Pareto composite score with transparent breakdown.
  5. Explain: Store `scheduler_decision` with:
     - `selected_node`: ID, name, score.
     - `rationale`: Human-readable summary.
     - `score_breakdown`: Itemized scores for battery, charging, thermal, network, reliability.
     - `excluded_candidates`: List of rejected nodes with specific disqualification reasons (e.g., `"Excluded phone-xyz: Battery 22% below required 30%"`).
- **Verification:**
  - Test verifying scheduler correctly filters out under-resourced nodes and records explanation.

### Phase 5: Provider Controls (Auto Accept / Ask Me / Scheduled Auto / Paused)
- **Files Modified:**
  - `apps/cloudflare-control-plane/src/coordinator.js`
  - `apps/android-node/app/src/main/java/dev/spaas/node/policy/ProviderSafetyPolicy.kt`
  - `apps/android-node/app/src/main/java/dev/spaas/node/service/ComputeWorkerClient.kt`
  - `apps/android-node/app/src/main/java/dev/spaas/node/MainActivity.kt`
- **Actions:**
  1. Define 4 Provider Modes:
     - `AUTO_ACCEPT`: Automatically accepts any job meeting policy rules.
     - `ASK_ME`: Enqueues an Offer; device displays interactive acceptance modal before downloading/executing.
     - `SCHEDULED_AUTO`: Auto-accepts only during designated hours (e.g., 22:00 - 07:00).
     - `PAUSED`: Contributes zero compute; heartbeats indicate paused state.
  2. Add `/api/v1/nodes/:id/offer/accept` and `/api/v1/nodes/:id/offer/decline` endpoints.
  3. Mobile "Ask Me" Dialog: Displays workload name, task description, CPU/RAM limits, battery impact estimate, reward in Test CR, and buttons for `Accept`, `Decline`, `Always Accept Similar`.
  4. Emergency Stop: Immediate termination of running workload and node status change to `PAUSED`.
- **Verification:**
  - Test offer/accept and offer/decline flows on backend and client.

### Phase 6: Fleet Management Engine (1–10k+ Nodes, Groups, Bulk Actions)
- **Files Modified:**
  - `apps/cloudflare-control-plane/src/coordinator.js`
  - `apps/web-console/src/main.js`
  - `apps/web-console/index.html`
- **Actions:**
  1. Add bulk selection: Multi-checkbox, "Select All", "Select Filtered".
  2. Bulk Actions: Batch Pause, Batch Resume, Batch Rebenchmark, Batch Set Policy, Batch Revoke, Batch Delete.
  3. Fleet Categorization: Filter by `Physical Android`, `iOS Nodes`, `Desktops`, `Emulators`, `Simulated`.
  4. Strict Isolation: Simulated nodes never contaminate production metrics or receive non-simulated workloads.
  5. Search and filter by model, node ID, status (`READY`, `BUSY`, `PAUSED`, `OFFLINE`), RAM, and battery.
- **Verification:**
  - Test bulk operations in `coordinator.test.js`.

### Phase 7: Web Console Visual/UX Overhaul (Progressive Disclosure & Wizard)
- **Files Modified:**
  - `apps/web-console/index.html`
  - `apps/web-console/src/main.js`
  - `apps/web-console/src/index.css`
- **Actions:**
  1. Overhaul Navigation Bar:
     - `Overview` | `Fleet` | `Workloads` | `Jobs` | `Usage & Credits` | `Administration`.
  2. Overview Dashboard:
     - Fabric Health status banner.
     - Live Capacity: Ready, Busy, Paused, Offline nodes.
     - Active Workload Throughput: Running, Queued, Completed, Failed jobs.
     - Network Credits Settled.
  3. Workload Studio Progressive Disclosure:
     - Simple Mode (Default): Card selector (Hello World, SHA-256, Prime Sieve, Matrix, Custom Upload) $\rightarrow$ Resource Sliders $\rightarrow$ Estimated Cost & Time $\rightarrow$ "Dispatch to Cluster".
     - Advanced Toggle: Raw YAML editor, Fuel Gas Limits, Memory Bytes, Leases, Fencing Tokens.
  4. Jobs View:
     - Tabs: `All` | `Queued` | `Offered` | `Running` | `Completed` | `Failed`.
     - Authoritative counts matching database query.
     - Job details pane showing: State machine progress bar, Device rationale ("Why this device?"), Sandboxed logs (stdout/stderr), Cryptographic Proof & Signature, Double-entry transaction link.
  5. Accessible Toasts & Action Dialogs:
     - Completely eliminate native `alert()` and `confirm()` calls in favor of accessible DOM toasts and modal confirmation dialogs.
     - Remove duplicate Add/Submit/Refresh controls.
- **Verification:**
  - Clean Vite production build with zero errors.

### Phase 8: Android Node UX Overhaul (Clean 6-Tab Architecture)
- **Files Modified:**
  - `apps/android-node/app/src/main/java/dev/spaas/node/MainActivity.kt`
  - `apps/android-node/app/src/main/java/dev/spaas/node/service/ComputeWorkerClient.kt`
  - `apps/android-node/app/src/main/java/dev/spaas/node/service/ComputeForegroundService.kt`
- **Actions:**
  1. Structure 6-Tab Bottom Navigation:
     - **Home:** Connected status (`READY`, `BUSY`, `PAUSED`), active workload card, live battery/thermal/RAM gauges, quick Pause/Resume switch.
     - **Jobs:** Sub-tabs for `Offers` (with Accept/Decline), `Assigned/Running` (with live progress bar), and `History` (with verified badges, fuel, wall time, and delete/clear controls).
     - **Performance:** Measured capabilities (WASM Fuel MIPS, Single/Multi-thread score, RAM Bandwidth, Network Latency, Thermal Drift), not generic vanity scores.
     - **Controls:** Mode selector (`AUTO_ACCEPT`, `ASK_ME`, `SCHEDULED_AUTO`, `PAUSED`), preset safety tiers (`Conservative`, `Balanced`, `Maximum`), custom sliders (Battery %, Charging Only, Unmetered Wi-Fi Only, Thermal Ceiling).
     - **Earnings:** Per-job, session, and lifetime Test CR earnings, transparent settlement formula.
     - **Security:** Node cryptographic ID, Ed25519 public key, sandbox isolation status, server verification attestation, Reset/Revoke identity buttons.
- **Verification:**
  - Verify Kotlin code structure, coroutine cancellation safety, and clean build.

### Phase 9: Real-time Convergence, Idempotency, and Lease Resilience
- **Files Modified:**
  - `apps/cloudflare-control-plane/src/coordinator.js`
  - `apps/web-console/src/main.js`
- **Actions:**
  1. Double-Entry Ledger:
     - Ensure exactly-once idempotent settlement via unique `idempotency_key` constraints (`settle_${job_id}_epoch${epoch}_debit` and `settle_${job_id}_epoch${epoch}_credit`).
     - Duplicate submissions return existing settlement without creating new ledger rows.
  2. Lease Expiration & Re-queue:
     - DO alarm sweeps expired leases, marks them `EXPIRED`, resets node state to `Ready`, and requeues jobs if `retry_count < max_retries`.
  3. Auto-reconnect & Staleness:
     - Web Console detects disconnected/stale backend and displays visual reconnection banner.
     - Android auto-reconnects with exponential backoff.
- **Verification:**
  - Automated tests for duplicate result idempotency, stale lease sweep, and reconnect backoff.

### Phase 10: Validation, Comprehensive Test Suites & Truthful Documentation
- **Actions:**
  1. Expand `apps/cloudflare-control-plane/tests/coordinator.test.js`:
     - Test all 12 state transitions.
     - Test generic workload execution (Hello World, SHA-256, Prime Sieve, Matrix Compute).
     - Test scheduler filtering and decision explainability.
     - Test provider policy enforcement and rejection handling.
     - Test bulk node management and simulated node isolation.
     - Target: $\ge 90\%$ control plane line coverage, 100% test pass rate.
  2. Verify Web Console Vite build.
  3. Update Documentation:
     - `WALKTHROUGH.md`: Complete before $\rightarrow$ after flow, architecture diagrams, test results, physical acceptance guidelines.
     - `REQUIREMENTS_TRACEABILITY.md`: Trace every requirement to code and tests.
     - `CHANGELOG.md`: Detailed entry for version 7.0.0.
     - `TODO.md`: Clear completed tasks and document future milestones.
- **Verification:**
  - Run all tests and verify 100% pass rate.

---

## 5. Acceptance Criteria

1. **Root-Cause Defect Resolution:**
   - `mode is not defined` error in Web Console completely eradicated.
   - Workload submission (`edge-matrix-multiplication` and all presets) succeeds without client errors.
   - Dispatched jobs on Android execute sandboxed WASM, verify SHA-256, and submit signed receipts without freezing in `DISPATCHED`.
   - Node state returns to `Ready` immediately upon job completion or failure, allowing queued jobs to be scheduled.

2. **Authoritative State Machine:**
   - 12 sequential states + 5 terminal/failure states strictly enforced in SQLite `job_transitions`.
   - Web Console displays live transitions with timestamps and explanations for queued status.

3. **Generic Workload Pipeline:**
   - Hello World, SHA-256 Hasher, Prime Sieve, Matrix Multiplication, and custom WASM all execute through the unified pipeline.
   - Double-entry ledger settlement awards Test CR based on verified fuel consumption.

4. **Capability-Aware Scheduler:**
   - Evaluates node hardware, battery, thermals, and provider policies.
   - Generates transparent `scheduler_decision` explaining why a node was chosen and why others were excluded.

5. **Provider Controls & Node UX:**
   - Android node supports Auto Accept, Ask Me, Scheduled Auto, Paused.
   - Clean 6-tab interface (Home, Jobs, Performance, Controls, Earnings, Security) with individual delete and clear all history controls.

6. **Web Console Visual UX:**
   - Modern, responsive, accessible progressive disclosure interface.
   - Simple Mode wizard for casual users, Advanced mode for power users.
   - No `alert()` dialogs.

7. **Test Quality & Evidence:**
   - 100% test pass rate across control plane test suite.
   - $\ge 90\%$ measured line coverage across Cloudflare DO control plane.
   - Strict evidence labeling throughout all documentation.
