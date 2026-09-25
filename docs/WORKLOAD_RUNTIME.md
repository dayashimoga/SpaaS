# SPaaS Workload Runtime Specification

## 1. WebAssembly / WASI Production Runtime
The default runtime environment for SPaaS edge execution is WebAssembly (WASI snapshot preview 1), implemented via the pure-Rust `wasmi` interpreter engine.

### 1.1 Determinism & Fuel Metering
- **Instruction Fuel**: Every WebAssembly opcode consumes fuel units configured via `limits.max_fuel`.
- **Watchdog Timeout**: In addition to instruction gas metering, a hard wall-clock timeout (`limits.timeout_ms`) monitors the thread to prevent hangs.
- **Linear Memory Isolation**: WebAssembly memory is confined to isolated linear pages with strict maximum byte quotas (`limits.max_memory_bytes`).

### 1.2 Sandboxed Host Environment
The host provides a minimal, isolated virtual WASI implementation:
- `fd_write`: Captures standard output (`fd 1`) and standard error (`fd 2`) into in-memory buffers up to `max_output_bytes` (1MB default). Write attempts exceeding quota return `EFBIG`.
- `fd_read`: Standard input returns zero bytes (EOF).
- `proc_exit`: Records process exit code and terminates execution gracefully.
- `random_get`: Provides cryptographically secure pseudo-random bytes.
- `clock_time_get`: Returns current execution time without exposing raw host hardware counters.
- **Filesystem & Network Syscalls**: All disk (`path_open`, `fd_readdir`) and socket calls are rejected with `ENOSYS` or `EPERM`.

---

## 2. Pluggable Runtime Trait (`WorkloadRuntime`)
```rust
#[async_trait]
pub trait WorkloadRuntime: Send + Sync {
    fn runtime_type(&self) -> RuntimeType;
    fn validate_spec(&self, spec: &WorkloadSpec) -> Result<(), RuntimeError>;
    async fn execute(&self, ctx: ExecutionContext<'_>) -> Result<JobResult, RuntimeError>;
}
```
This abstraction provides seamless extensibility for future edge runtimes such as ONNX AI inference, TFLite, and native MicroVM containers.
