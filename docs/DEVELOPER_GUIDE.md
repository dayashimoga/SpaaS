# SPaaS Contributor & Developer Manual

## 1. Codebase Architecture & Monorepo Layout

SPaaS is structured as a modular Rust monorepo managed by Cargo workspaces, paired with an Android worker application and a responsive Web Management Console:

```
├── Cargo.toml                  # Root workspace definition
├── apps/
│   ├── control-plane/          # Axum HTTP/SSE server, state manager & reconciler
│   ├── android-node/           # Android Jetpack Compose volunteer worker client
│   └── web-console/            # Production Vite frontend & CSS design system
├── crates/
│   ├── protocol/               # Universal wire protocols, serde models, and state machines
│   ├── security/               # Ed25519 signing, SHA-256 verification, token authorization
│   ├── runtime/                # Deterministic WASM/WASI engine & gas metering
│   ├── scheduler-core/         # Multi-attribute scoring engine & candidate filter
│   ├── metering/               # Dual-entry ledger, fuel accounting, and credit balances
│   ├── persistence/            # Write-Ahead Log (WAL) and idempotent state recovery
│   ├── verification/           # Execution proof verification & consensus policies
│   ├── telemetry/              # Prometheus metrics registry and structured tracing
│   └── node-agent/             # Lightweight volunteer daemon for edge hardware
├── tests/
│   └── integration/            # Comprehensive multi-node end-to-end integration tests
└── scripts/                    # Automation scripts for build, dev, and certification
```

---

## 2. Developing WASM Workload Modules

All workloads executed across the SPaaS compute fabric run within a deterministic WebAssembly runtime targeting the standard WASI preview 1 (`wasm32-wasip1`) environment.

### Compiling from Rust
Create a standard Rust binary crate:
```bash
cargo new --bin my-workload
cd my-workload
```

Write your deterministic computation logic in `src/main.rs`:
```rust
use std::io::{self, Read, Write};

fn main() -> io::Result<()> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;

    let result = process_data(&input);

    io::stdout().write_all(result.as_bytes())?;
    Ok(())
}

fn process_data(data: &str) -> String {
    format!("Processed {} characters successfully", data.len())
}
```

Compile targeting WebAssembly:
```bash
rustup target add wasm32-wasip1
cargo build --target wasm32-wasip1 --release
```
The resulting binary is located at `target/wasm32-wasip1/release/my_workload.wasm`.

### Execution Constraints & Invariants
- **Deterministic Sandboxing**: Workloads are isolated from host OS resources. Direct network sockets, arbitrary filesystem access, and unsandboxed threads are blocked by default.
- **Gas & Fuel Metering**: Every WebAssembly instruction consumes deterministic fuel units. An execution exceeding `max_fuel` is immediately halted with `OutOfGas`.
- **Memory Limits**: Memory is constrained to `max_memory_bytes` (typically 4MB to 64MB). Allocations exceeding this threshold trigger out-of-memory errors.

---

## 3. Protocol Evolution & Backward Compatibility

When modifying data models in `crates/protocol`:
1. Always implement or derive `Default` for new structs.
2. Use `#[serde(default)]` on optional or newly added fields to preserve deserialization compatibility with older agents.
3. In Rust code across other crates, construct structs using `..Default::default()` to avoid breaking downstream callers when new fields are introduced.
4. Maintain monotonic version numbers in `spec_version` and `schema_version`.

---

## 4. Coding Standards & Error Handling

- **Error Types**: Use strongly typed `enum` errors (e.g. `thiserror`) for internal crate boundaries. Avoid indiscriminate string error conversion until presentation or API boundary.
- **Async Concurrency**: Use Tokio async primitives (`tokio::sync::RwLock`, `tokio::sync::mpsc`). Never hold synchronous locks across `.await` points.
- **Structured Logging**: Use the `tracing` crate (`tracing::info!`, `tracing::warn!`, `tracing::error!`) with structured key-value pairs (e.g. `tracing::info!(job_id = %job.id, "Job scheduled")`).
- **Formatting**: Run `cargo fmt --all` before committing any code changes.

---

## 5. Testing Philosophy & Test Organization

- **Unit Tests**: Place in `tests` modules within each crate (`#[cfg(test)] mod tests { ... }`).
- **Integration Tests**: Place in `tests/integration/tests/`. Every major user flow (node enrollment, job dispatch, failure recovery, scheduler scoring) has dedicated end-to-end integration tests.
- **Regression Protection**: Always add an automated test verifying the fix for any reported defect or edge case.
