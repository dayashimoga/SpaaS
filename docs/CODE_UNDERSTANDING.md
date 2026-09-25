# SPaaS Code Understanding & Deep Dive

## 1. Key Code Path Walkthroughs

### 1.1 How Workload Sandboxing Works (`crates/workload-runtime`)
When a workload arrives at an edge node:
1. `WasmWasiRuntime::validate_spec` ensures fuel and timeout parameters are positive integers.
2. `verify_sha256` recalculates the SHA-256 digest of the raw wasm bytes and cross-checks it against `spec.artifact_sha256`.
3. `wasmi::Module::new(&engine, wasm_bytes)` parses and validates WebAssembly bytecode.
4. `link_sandboxed_wasi` hooks host wrappers into WASI snapshot preview 1.
5. `store.set_fuel(limits.max_fuel)` establishes the execution budget.
6. If an infinite loop or gas-heavy code runs, `wasmi` traps with an out-of-fuel error; if CPU time exceeds `limits.timeout_ms`, the Tokio timeout task aborts execution.
7. Captured stdout/stderr are capped at `limits.max_output_bytes` to prevent buffer overflow attacks.
8. The result digest is generated via `JobResult::compute_digest` and signed using the node's Ed25519 keypair.

### 1.2 How Edge Scheduling Works (`crates/scheduler-core`)
1. Hard eligibility filtering (`filter::evaluate_node_eligibility`) eliminates nodes that are paused, offline, low on battery, or overheating.
2. The remaining nodes are passed to `scorer::score_node`, which computes a weighted aggregate score based on charging status (AC vs battery), battery percentage, thermal headroom, network transport, ping latency, and reliability.
3. The highest-scoring node is selected and bound to the job.

### 1.3 How Autonomous Rescheduling Works (`apps/control-plane/src/reconciler.rs`)
1. Every 1.5 seconds, the reconciler checks the last heartbeat timestamp of all registered nodes.
2. Nodes inactive for $> 20$ seconds are marked `NodeState::Offline`.
3. Any active jobs assigned to these offline nodes have their state transitioned to `JobState::Retrying` (if `retry_count < max_retries`) and are immediately placed back into `JobState::Queued`.
4. The scheduler automatically dispatches queued jobs to the next available healthy node.
