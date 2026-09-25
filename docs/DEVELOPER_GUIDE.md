# SPaaS Contributor & Developer Manual

## 1. Codebase Architecture
SPaaS is organized as a Rust monorepo with accompanying Android and Web applications:
- `crates/protocol`: Universal data structures and state machines
- `crates/security`: Cryptographic primitives and threat mitigations
- `crates/workload-runtime`: WASM engine and sandbox abstraction
- `crates/scheduler-core`: Decision engine for node selection
- `crates/metering`: Credit accounting and double-entry ledger
- `crates/verification`: Result integrity and consensus algorithms
- `crates/telemetry`: Metrics and distributed tracing
- `crates/node-agent`: Core edge worker logic
- `apps/control-plane`: Axum API server and reconciler
- `apps/android-node`: Android 15 Jetpack Compose native application
- `apps/web-console`: Vite + CSS Design System management console

---

## 2. Writing Workload Modules
Workloads should compile to standard WebAssembly targeting WASI preview 1 (`wasm32-wasip1`).
Entrypoint standard: `_start` or custom exported typed function.
Memory limits: Keep linear memory allocations below 64MB.
Syscalls: Filesystem operations should use in-memory buffers or pre-opened sandboxed channels.
