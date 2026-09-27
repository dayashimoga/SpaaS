# SPaaS Security Architecture & Threat Mitigations

## 1. Zero-Trust Security Philosophy

In the SPaaS Universal Edge Compute Fabric, **zero trust** is an immutable operational invariant:
- **Untrusted Edge Nodes**: Volunteer smartphones and edge workstations are assumed to be potentially compromised, adversarial, or unreliable.
- **Untrusted Workloads**: User-submitted WebAssembly code is treated as potentially malicious (e.g. attempting infinite loops, memory exhaustion, or sandbox escapes).
- **Untrusted Consumers**: Submitter balances and signatures are verified cryptographically before admission.

---

## 2. Defensive Controls Matrix

| Threat Vector | Potential Impact | Defensive Architecture & Mitigation |
|---|---|---|
| **Malicious Workload (Infinite Loop)** | CPU & Battery exhaustion | Deterministic WebAssembly fuel metering; instant termination upon reaching `max_fuel` ceiling. |
| **Malicious Workload (Memory Exhaustion)** | Host crash / OOM kill | Strict linear memory ceiling (`max_memory_bytes`); pre-allocated memory boundaries enforced by runtime. |
| **Sandbox Breakout / Host Escape** | Host system compromise | Pure-Rust `wasmi` interpreter with zero host system call passthrough; strictly sandboxed WASI preview 1. |
| **Forged or Poisoned Results** | Corrupted compute outputs | Dual-execution quorum verification (`hash_match`), deterministic replay, and Ed25519 signature validation. |
| **Replay Attacks** | Duplicate job processing | Short-lived bearer tokens with monotonic nonces, UUID v4 lease identifiers, and strict timestamp windows. |
| **Node Impersonation** | Unauthorized node actions | Asymmetric Ed25519 public/private key pairs; node enrollment signature verification against challenge nonces. |
| **Double Spending / Duplicate Billing** | Accounting discrepancy | Double-entry ledger enforcing unique `idempotency_key` based on $\text{SHA-256}(\text{job\_id} \parallel \text{node\_id} \parallel \text{result\_digest})$. |
| **Host Ingress Flooding / DoS** | Control plane saturation | Token bucket rate limiting (100 req/sec per IP) and strict payload size limits (max 10MB). |
| **Mobile Owner Privacy Leak** | Private data harvesting | Android application requests **zero** sensitive Android permissions (no contacts, camera, mic, or storage access). |

---

## 3. Cryptographic Primitives & Key Management

SPaaS adheres to modern, battle-tested cryptographic standards:

### 3.1 Asymmetric Digital Signatures
- **Algorithm**: Ed25519 (Edwards-curve Digital Signature Algorithm over Curve25519, RFC 8032).
- **Control Plane Server Key**: Persisted in `data/server_key.json` using encrypted or mode-600 filesystem storage.
- **Node Keys**: Generated locally on each edge device during enrollment. Private keys never leave the device boundary (stored in Android KeyStore or local secure storage).

### 3.2 Integrity Digests & Canonical Serialization
- **Hash Function**: SHA-256 (FIPS 180-4).
- **Canonical Serialization**: Prior to signing, all structured payloads (workload specs, job results, metering entries) are serialized to canonical JSON format to ensure byte-exact determinism across platforms.

---

## 4. API Authentication & Middleware

The control plane implements configurable bearer token authentication:
- **Header**: `Authorization: Bearer <SPAAS_AUTH_TOKEN>`
- **Exempt Public Routes**:
  - `GET /health` (Liveness / readiness probe)
  - `POST /api/v1/devices/pair` (Node enrollment pairing)
  - `GET /downloads/*` (Worker binaries and installation scripts)
  - `GET /` and `/assets/*` (Static web console assets)
- **Protected Routes**: Job submissions (`POST /api/v1/jobs`), node state modifications, cancellations, and administration endpoints.

---

## 5. Sandboxing & Runtime Isolation

The WebAssembly sandbox isolates executing guest code through several layers:
1. **Memory Isolation**: WebAssembly linear memory cannot access host pointers or address spaces outside its allocated buffer.
2. **Capability-Based I/O**: Filesystem and network operations are disabled by default. Workloads interact solely through standard input and output streams.
3. **Execution Ceilings**: Strict timeout monitors in Tokio background tasks enforce hard termination even if execution hangs.

---

## 6. Multi-Cloud Disaster Recovery & Split-Brain Security

To guarantee security and data consistency across multi-cloud failovers:
- **Control-Plane Epochs:** Monotonically increasing counter (Epoch 1 = Cloudflare Primary, Epoch 2 = Cloud Run Standby). Any lease renewal or result settlement with an epoch lower than the active epoch is rejected with `HTTP 409 Conflict`.
- **Fencing Tokens:** Unique cryptographically random tokens bound to leases. Stale workers attempting to submit results from previous epochs cannot settle credits.
- **Standby Isolation:** Cloud Run dormant instance rejects job submissions (`HTTP 412 Precondition Failed`), preventing accidental concurrent scheduling.
- **Operator-Approved Promotion:** Failover requires authenticated `POST /api/v1/dr/activate` with `SPAAS_DR_OPERATOR_SECRET` to prevent automated split-brain flaps.

---

## 7. Free-Tier Cost Defense & Safe Operational Limits

| Platform | Resource | Free-Tier Allowance | SPaaS Architecture Defensive Limit |
|---|---|---|---|
| **Cloudflare Workers** | Requests | 100,000 requests/day | Rate limiter + batching (capped at 50,000 req/day) |
| **Cloudflare Workers** | CPU Time | 10ms per request | Request-driven DO dispatch; heavy compute delegated to edge nodes |
| **Cloudflare DO** | Storage | 1 GB storage | SQLite transactional storage (`ctx.storage.sql`); historical jobs trimmed |
| **Cloudflare DO** | WebSockets | Included | WebSocket Hibernation API: zero CPU/memory charge while idle |
| **Google Cloud Run** | Requests | 2,000,000 requests/month | Cold standby (`minScale: 0`); dormant until failover |
| **Google Cloud Run** | Compute | 360,000 vCPU-seconds/mo | Zero compute consumed while dormant ($0.00 idle cost) |

