# SPaaS Protocol & RPC Specification

## 1. Wire Format
- **Transport**: HTTP/1.1 and HTTP/2 over TLS
- **Encoding**: JSON (canonical RFC 8259) with Base64 encoding for binary WebAssembly payloads and cryptographic signatures.
- **Idempotency**: All mutation endpoints (registration, heartbeats, results) accept idempotent requests.

---

## 2. State Machines

### 2.1 Job State Machine
```
   [Queued] ────(scheduled)────> [Scheduled] ────(start)────> [Running]
      │                               │                           │
  (cancel)                         (timeout)                   (timeout)
      │                               │                           │
      v                               v                           v
 [Cancelled] <─────────────────── [Retrying] ─────────────────> [Failed]
                                      │                           ▲
                                      v                           │
                                  [Queued]                 (consensus fail)
                                                                  │
                              [Verifying] ────────────────────────┘
                                   │
                               (verified)
                                   v
                              [Completed]
```

### 2.2 Node Lifecycle
- `Enrolled`: Actively eligible for workload dispatch
- `Unenrolled`: Provider removed node from compute fabric
- `Active`: Currently executing a sandboxed workload
- `Idle`: Ready and awaiting job assignments
- `Paused`: Compute suspended due to battery, thermals, cellular data, or user toggle
- `Offline`: Missed periodic heartbeats; marked unreachable by reconciler
