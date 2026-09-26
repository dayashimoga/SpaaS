# SPaaS Engineering Team Onboarding Guide

## 1. Welcome to the SPaaS Project

Welcome to the SPaaS engineering team! SPaaS (Smartphone Platform as a Service) is a distributed universal edge compute fabric designed to orchestrate volunteer compute power across smartphones, desktops, and edge devices with zero-trust cryptographic guarantees.

This guide provides a rapid, structured path for new contributors to set up their workstation, understand system boundaries, and land their first contribution.

---

## 2. Day-1 Quickstart: Verify Your Environment

### 2.1 Clone and Verify Local Toolchain
Ensure you have the required prerequisites:
- **Rust**: 1.80+ (`rustup default stable && rustup target add wasm32-wasip1`)
- **Node.js**: 20 LTS + npm 10+
- **Podman / Docker**: 4.5+ (optional for containerized runs)
- **PowerShell 7+** (Windows) or **Bash** (macOS / Linux)

Clone the repository and run the acceptance gate:
```powershell
# Clone workspace
git clone https://github.com/dayashimoga/SpaaS.git
cd SpaaS

# Run the automated acceptance gate
.\scripts\acceptance.ps1    # or ./scripts/acceptance.sh
```
Passing all gates confirms your compiler, cryptographic libraries, runtime sandbox, and frontend build tools are correctly configured.

---

## 3. Architecture & Subsystem Navigation

| Subsystem | Primary Directories | Technical Focus |
|---|---|---|
| **Control Plane & Reconciler** | `apps/control-plane/` | Axum HTTP/SSE server, state management, heartbeat tracking, lease reconciliation. |
| **Scheduler Engine** | `crates/scheduler-core/` | Candidate qualification, Pareto multi-attribute scoring, constraint validation. |
| **WASM Runtime & Sandbox** | `crates/runtime/` | `wasmi` interpreter, instruction gas metering, WASI memory and IO isolation. |
| **Zero-Trust Security** | `crates/security/`, `crates/verification/` | Ed25519 digital signatures, canonical serialization, cryptographic result proof verification. |
| **Economics & Metering** | `crates/metering/` | Double-entry ledger, idempotency keys, TEST CREDITS settlement. |
| **Mobile Worker Client** | `apps/android-node/` | Android 15 Jetpack Compose app, persistent foreground service, thermal and battery monitoring. |
| **Web Console UI** | `apps/web-console/` | Pure JS/CSS design system, Vite compilation, live SSE stream rendering. |

---

## 4. Your First Contribution Workflow

1. **Create a Feature Branch**:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. **Implement Changes & Tests**:
   - Write clean, well-commented code following the repository standards.
   - Accompany code changes with corresponding unit or integration tests.
3. **Run Pre-Commit Verification**:
   ```bash
   # Format code
   cargo fmt --all

   # Check linter warnings
   cargo clippy --workspace --all-targets -- -D warnings

   # Run test suite
   cargo test --workspace

   # Build frontend bundle
   cd apps/web-console && npm run build && cd ../..
   ```
4. **Submit Pull Request**:
   - Ensure PR title follows Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`).
   - Link any related issue or gap identifier.

---

## 5. Development Tips & Common Pitfalls

- **Avoid Holding Locks Across Async Await**: In Tokio asynchronous handlers, do not hold a synchronous `std::sync::MutexGuard` across `.await` points. Always use `tokio::sync::RwLock` or `tokio::sync::Mutex`.
- **WASM Gas Metering**: Infinite loops in workloads are caught deterministically by `wasmi` fuel exhaustion. When writing workload tests, verify fuel consumption using `job.result.fuel_consumed`.
- **Forward-Compatible Structs**: When instantiating `WorkloadSpec`, `NodeRecord`, or `JobRecord`, always use `..Default::default()` to guard against compiler breakage when new protocol fields are added.
