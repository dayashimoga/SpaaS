# SPaaS Workload Runtime Specification

## 1. WebAssembly / WASI Production Runtime

The SPaaS execution engine (`crates/runtime`) sandboxes user workloads using WebAssembly with the standard WASI (WebAssembly System Interface) snapshot preview 1 specification. The runtime is implemented via `wasmi`, a deterministic, pure-Rust WebAssembly interpreter.

```
┌────────────────────────────────────────────────────────┐
│             SPaaS Host Execution Boundary              │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │       WASM / WASI Sandbox (wasmi v0.40)          │  │
│  │                                                  │  │
│  │   Guest User Workload (Compiled wasm32-wasip1)   │  │
│  │   - Linear Memory (Bounded: max_memory_bytes)    │  │
│  │   - Gas Fuel Meter (Strict Ceiling: max_fuel)    │  │
│  │   - Standard IO Interceptor (Captured in memory) │  │
│  └──────────────────────────────────────────────────┘  │
│                           ▲                            │
│                           │ Sandboxed Syscall Boundary │
│                           ▼                            │
│  ┌──────────────────────────────────────────────────┐  │
│  │       Minimal Virtual Host WASI Interface        │  │
│  │       (Zero Host FS / Zero Raw Network Sockets)  │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

---

## 2. Determinism, Fuel Metering, & Isolation Guarantees

### 2.1 Opcode Fuel Consumption
Every executed WebAssembly instruction decrements the thread's remaining fuel counter. If fuel reaches zero, the interpreter immediately traps with `OutOfGas`, guaranteeing deterministic termination of infinite loops or denial-of-service attempts.

| Opcode Category | Representative Instructions | Fuel Cost |
|---|---|---|
| **Basic Arithmetic** | `i32.add`, `i64.sub`, `i32.mul` | `1 fuel` |
| **Bitwise Operations** | `i32.and`, `i64.or`, `i32.xor`, `i32.shl` | `1 fuel` |
| **Control Flow** | `block`, `loop`, `if`, `br`, `br_if` | `2 fuel` |
| **Function Calls** | `call`, `call_indirect` | `5 fuel` |
| **Memory Access** | `i32.load`, `i64.store`, `memory.grow` | `3 to 10 fuel` |

### 2.2 Linear Memory Bounds Enforcement
- Guest memory is restricted to isolated linear memory pages (64KB per page).
- Maximum memory is strictly clamped by `limits.max_memory_bytes` (default 4MB to 64MB).
- Calls to `memory.grow` that would exceed the configured ceiling return `-1`, preventing memory bombs or host OOM kills.

### 2.3 Wall-Clock Watchdog Timeout
In addition to instruction fuel ceilings, execution is wrapped in a Tokio asynchronous `timeout` watchdog (`limits.timeout_ms`). If execution exceeds the allotted duration (e.g. 15,000 ms), the worker aborts execution and yields resources.

---

## 3. Sandboxed Host Environment & Syscall Interception

The runtime provides an in-memory virtual WASI implementation:

- **`fd_write`**: Intercepts standard output (`fd 1`) and standard error (`fd 2`). Data is captured into dedicated circular memory buffers up to `max_output_bytes` (default 1MB). Writes exceeding quota return `EFBIG`.
- **`fd_read`**: Intercepts standard input (`fd 0`). Returns zero bytes (EOF) unless explicit input payloads are provided.
- **`proc_exit`**: Captures process exit code and halts interpretation gracefully.
- **`random_get`**: Supplies cryptographically secure pseudo-random bytes from the host entropy source.
- **`clock_time_get`**: Returns normalized system time without exposing raw CPU performance counters to prevent timing side-channel attacks.
- **Blocked Syscalls**: All filesystem manipulation (`path_open`, `fd_readdir`, `path_unlink`), socket networking (`sock_send`, `sock_recv`), and subprocess spawning are blocked with `ENOSYS` or `EPERM`.

---

## 4. Pluggable Runtime Trait (`WorkloadRuntime`)

The compute fabric defines a pluggable runtime interface:

```rust
#[async_trait]
pub trait WorkloadRuntime: Send + Sync {
    /// Identifies the runtime engine type (e.g. WasmWasi, OnnxRuntime, MicroVM)
    fn runtime_type(&self) -> RuntimeType;

    /// Validates workload specification constraints before admission
    fn validate_spec(&self, spec: &WorkloadSpec) -> Result<(), RuntimeError>;

    /// Executes the sandboxed workload with fuel and memory monitoring
    async fn execute(&self, ctx: ExecutionContext<'_>) -> Result<JobResult, RuntimeError>;
}
```

This abstraction allows future expansions—such as ONNX AI models on mobile NPUs or AVF pKVM microVMs—without altering the scheduler or control plane protocols.
