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

---

## 3. Running Tests Locally

### Run All Workspace Unit & Integration Tests
```bash
cargo test --workspace
```

### Run a Specific Integration Test
```bash
cargo test --test multi_device_enrollment
cargo test --test adversarial_security
cargo test --test e2e_workload_lifecycle
```

### Run Tests with Verbose Output and Backtraces
```bash
RUST_BACKTRACE=1 cargo test -- --nocapture
```

### Measure Code Coverage
Using `cargo-llvm-cov`:
```bash
cargo llvm-cov --workspace --html
# Open target/llvm-cov/html/index.html to view line and branch coverage
```

---

## 4. Continuous Integration Acceptance Gates

In CI environments, code cannot be merged without passing the authoritative acceptance script:
```powershell
.\scripts\acceptance.ps1 -Full    # Windows PowerShell
./scripts/acceptance.sh --full    # Linux / macOS POSIX Shell
```

The script verifies:
1. `cargo check --workspace --all-targets` (Clean compilation)
2. `cargo clippy --workspace --all-targets -- -D warnings` (Strict linting)
3. `cargo test --workspace` (All 80+ tests green)
4. `npm run build` in `apps/web-console` (Vite production bundle generated)
5. Control plane live daemon health check and synthetic smoke test.
