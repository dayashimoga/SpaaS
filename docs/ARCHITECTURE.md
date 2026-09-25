# SPaaS System Architecture

## Architectural Principles
1. **Zero Trust Mutual Isolation**: Both submitters and worker nodes are untrusted. Submitters might submit malicious bytecode (infinite loops, memory bombs, RCE attempts); nodes might return corrupted or fabricated results.
2. **Mobile First & Owner Priority**: Phones run on batteries and heat up under sustained load. The phone owner's daily experience is strictly prioritized over external compute workloads.
3. **Deterministic Sandboxing**: WebAssembly linear memory and fuel metering guarantee predictable resource consumption and reproducible execution.
4. **Transient Edge Resilience**: Edge nodes can disconnect without warning. The orchestrator never assumes persistent connectivity.

---

## Detailed Data Flow

```mermaid
sequenceDiagram
    autonumber
    actor Developer as Developer / CLI / Console
    participant CP as Control Plane
    participant DB as State / Ledger
    participant Sched as Edge Scheduler
    participant Node as Android / Edge Node
    participant Wasm as Sandboxed WASI Engine

    Developer->>Developer: Sign WorkloadSpec with Ed25519
    Developer->>CP: POST /api/v1/jobs (spec, wasm_bytes)
    CP->>CP: Verify Submitter Signature & SHA-256
    CP->>DB: Store Job in QUEUED state
    CP->>Sched: Evaluate Active Enrolled Nodes
    Sched->>Sched: Filter by capability & Score by battery/thermals/charging
    Sched-->>CP: Select Optimal Node
    CP->>DB: Transition Job to SCHEDULED
    Node->>CP: GET /api/v1/nodes/:id/poll
    CP-->>Node: Dispatch Message (spec, wasm)
    Node->>Node: Verify Submitter Signature & Safety Constraints
    Node->>Wasm: Instantiate with Fuel Limit (e.g. 5M) & Memory Limit (64MB)
    Wasm->>Wasm: Deterministic execution with timeout watchdog
    Wasm-->>Node: Exit Code, Stdout, Stderr, Fuel Consumed
    Node->>Node: Compute Result Digest & Sign with Node Key
    Node->>CP: POST /api/v1/nodes/results (JobResult)
    CP->>CP: Verify Node Cryptographic Signature & Digest
    CP->>DB: Record Metering with Idempotency Key
    CP->>DB: Transition Job to COMPLETED
    Developer->>CP: GET /api/v1/jobs/:id/logs
    CP-->>Developer: Verified Output & Telemetry
```

---

## Component Topology

### Ingress Gateway (`apps/gateway`)
The boundary reverse proxy responsible for TLS termination, client rate limiting, and routing incoming traffic to the internal Control Plane.

### Control Plane (`apps/control-plane`)
The core orchestrator written in Rust on top of Axum. It maintains the authoritative state machines for nodes and jobs, orchestrates workload dispatching, enforces timeouts, and drives the autonomous reconciliation loop.

### Edge Scheduler (`crates/scheduler-core`)
A multi-criteria decision engine that evaluates battery charge, AC/wireless charging, thermal state, unmetered network transport, CPU architecture, and historical reliability to rank candidate workers.

### Workload Runtime (`crates/workload-runtime`)
The execution sandbox built on `wasmi`. It provides instruction fuel metering, memory bounds enforcement, standard I/O capture with strict quotas, and an extensible `WorkloadRuntime` trait.

### Node Agent (`crates/node-agent`)
The worker daemon that runs across Android, desktop, and server hosts. It integrates with system sensors, executes workloads inside the runtime, and triggers automatic safety yields.
