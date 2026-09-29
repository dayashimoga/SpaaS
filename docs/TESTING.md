# SPaaS Comprehensive Testing Framework

## 1. Testing Philosophy & Verification Standards

The SPaaS Universal Edge Compute Fabric adheres to strict verification principles:
- **100% Determinism**: Unit and integration tests must run deterministically with zero flaky behavior or timing-dependent race conditions.
- **Defense in Depth**: Every security control (signature verification, gas limits, path sanitation) has matching negative adversarial tests.
- **Zero Regressions**: Any fixed bug or edge case must include an automated regression test.

---

## 2. Testing Pyramid & Suite Anatomy

```
               ▲
              / \
             /   \      E2E Integration & Microservice Tests
            / E2E \     (Multi-Device Enrollment, Dropout Recovery, Settlement)
           /───────\
          /         \   Adversarial & Fuzz Suites
         / Security  \  (Signature Forgery, Infinite Loops, Replay Attacks)
        /─────────────\
       /               \ Core Unit Tests
      /   Unit Tests    \ (Protocol Serde, Gas Metering, Scheduler Filters)
     /───────────────────\
```

### 2.1 Crate Unit Test Suites
- **`spaas-protocol`**: Exhaustive state machine transitions, canonical JSON serialization, and evidence classification tags.
- **`spaas-security`**: Ed25519 key generation, canonical byte hashing, signature mutation rejection, and token verification.
- **`spaas-runtime`**: WebAssembly engine loading, deterministic gas consumption, infinite loop interruption (`OutOfGas`), and linear memory bounds.
- **`spaas-scheduler-core`**: 100% branch coverage of candidate filtering (`RegionMismatch`, `CategoryNotAllowed`, `DeadlineInfeasible`, `CostExceedsMax`) and Pareto scoring.
- **`spaas-metering`**: Double-entry ledger invariant checks, transaction fee calculations, and idempotency key deduplication.
- **`spaas-verification`**: Single-node cryptographic audit and multi-node Byzantine quorum voting algorithms.

### 2.2 Integration Test Suites (`tests/integration/tests/`)
- **`multi_device_enrollment.rs`**: Concurrently registers 5 heterogeneous devices (phones, emulators, desktops) and validates isolated lifecycle state updates.
- **`e2e_workload_lifecycle.rs`**: Full lifecycle: submission $\to$ scheduling $\to$ lease grant $\to$ execution $\to$ result signing $\to$ ledger deduction.
- **`adversarial_security.rs`**: Injects poisoned bytecode, forged signatures, expired lease tokens, and path traversal attempts.
- **`node_disappearance_reschedule.rs`**: Simulates catastrophic node crash during execution; validates lease forfeiture and autonomous rescheduling.
- **`scheduler_multi_attribute.rs`**: Validates scale (100 to 10,000 nodes), thermal throttling penalties, and cost ceiling enforcement.

### 2.3 Cloudflare Control Plane Test Suite (`apps/cloudflare-control-plane/tests/coordinator.test.js`)
The control plane test suite runs via Node.js native test runner with experimental code coverage:
- **Subtest 1**: Public Health & System Diagnostics
- **Subtest 2**: Rate Limiting Enforcement
- **Subtest 3**: Administrative Authentication Boundaries
- **Subtest 4**: Single-Use Pairing Tokens & Device Registration
- **Subtest 5**: Device Authentication for Heartbeat & Results
- **Subtest 6**: Workload Submission, Placement & Dynamic Settlement
- **Subtest 7**: Operational Fabric Controls & Emergency Stop
- **Subtest 8**: Device Revocation & DR Checkpoint Export
- **Subtest 9**: SPaaS Gateway — Ingress CORS & APK Download Metadata
- **Subtest 10**: DO Alarms, Lease Reconciler & Node Heartbeat Timeout
- **Subtest 11**: WebSocket Hibernation Messaging
- **Subtest 12**: Node Operational Management (Rename, State, Delete)
- **Subtest 13**: Job Queries, Decisions, Cancellation & Challenge Workload
- **Subtest 14**: Ledger, Demo Simulated Cluster & Audit Log
- **Subtest 15**: True Double-Entry Ledger & CSV Download (GAP-M06)
- **Subtest 16**: Cross-Cloud DR Epoch Handoff & Fencing
- **Subtest 17**: Empirical Qualification & Challenge Dispatch
- **Subtest 18**: End-to-End Authoritative Challenge Lifecycle, ACK, START, Verification & Trace
- **Subtest 19**: Comprehensive Failure, Security, Rejection & Recovery Boundaries
- **Subtest 20**: Fleet Inventory, WebSocket Hibernation Full Lifecycle, APK Downloads & Bulk Pruning

**Pass Rate:** 100% (20/20 passed)  
**Measured Line Coverage:**
- `src/coordinator.js`: **91.25%**
- `src/index.js`: **83.07%**
- `src/sqlite-bridge.js`: **81.04%**
- `tests/coordinator.test.js`: **100.00%**
- **Overall Control Plane:** **92.38%** (Target: ≥90%)

---

## 3. Running Tests Locally

### Run All Workspace Unit & Integration Tests (Rust)
```bash
cargo test --workspace
```

### Run Adversarial Security Tests
```bash
cargo test --test adversarial_security
```

### Run Cloudflare Control Plane Test Suite with Coverage (Node.js)
```bash
cd apps/cloudflare-control-plane
npm test
```

### Build Web Console Production Bundle
```bash
cd apps/web-console
npm run build
```

---

## 4. Continuous Integration Acceptance Gates

In CI environments, code cannot be merged without passing all verification gates:
1. `cargo check --workspace --all-targets` (Clean compilation)
2. `cargo clippy --workspace --all-targets -- -D warnings` (Strict linting)
3. `cargo test --workspace` (All 80+ Rust tests green)
4. `npm test` in `apps/cloudflare-control-plane` (20/20 tests green, ≥90% line coverage)
5. `npm run build` in `apps/web-console` (Vite production bundle generated)
6. Automated edge deployment to Cloudflare Pages and Workers DO.
