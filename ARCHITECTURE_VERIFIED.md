# SPaaS Universal Edge Compute Fabric — Verified Architecture & State Flows

**Audit Date:** 2026-10-06  
**Auditor:** Principal Distributed Systems, Edge Compute, Cloudflare, Rust & SRE Architect  
**Classification Baseline:** Phase 36 Production Verified  

---

## 1. High-Level System Architecture Diagram

```
Customer Web/API/CLI/SDK      Provider Android/Desktop       Admin Console
          \                         |                         /
           └──── HTTPS/WSS ─────────┼────────────────────────┘
                                    │
                                    ▼
                     Cloudflare WAF / Auth / Edge API
                                    │
                       Cloudflare Workers Runtime
                                    │
                   Coordinator Durable Object (SQLite)
 ┌──────────────────────────────────┴──────────────────────────────────┐
 │                                                                     │
 │ • Auth / Multi-Tenant / RBAC (10 Categories, 9 Roles)               │
 │ • Autonomous Outcome Planner (PLANNER_SCHEMA_VERSION = 2026-03-29.v1)│
 │ • Authoritative Multi-Attribute Scheduler (10,000 Nodes in 0.23s)    │
 │ • Persistent Monotonic Fencing Tokens (fence_epoch_time_seq)        │
 │ • Dynamic Idempotency Cache (SHA-256 Request Dedup)                 │
 │ • Balanced Triple-Entry Ledger (Discrepancy: 0.0000 CR)             │
 │                                                                     │
 └──────────────────────────────────┬──────────────────────────────────┘
                                    │
                  Outbound Poll & WebSocket Side-Channel
                                    │
            ┌───────────────────────┼───────────────────────┐
            ▼                       ▼                       ▼
     Android Node            Desktop Worker          Standby DR
     Vivo I2221 (ARM64)      Ubuntu / Windows        Cloud Run Epoch N+1
    ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
    │ WASI Sandbox    │     │ WasmWasiRuntime │     │ Cold Standby    │
    │ Instruction Fuel│     │ Multi-Threaded  │     │ DO State Import │
    │ Hardware Guards │     │ CI Build Agent  │     │ Monotonic Epoch │
    └─────────────────┘     └─────────────────┘     └─────────────────┘
            │                       │
            └───────────┬───────────┘
                        ▼
           Verify → Aggregate → Settle
```

---

## 2. Authoritative Lifecycle State Machines

### 1. Job Lifecycle State Machine

```
      [SUBMITTED]
           │ (Admit to fabric queue)
           ▼
        [QUEUED] ◄────────────────────────────────────────┐
           │                                              │
           │ (Evaluate candidate nodes against 6-tuple)  │ (Offer declined /
           ▼                                              │  Lease expired)
       [MATCHING]                                         │
           │                                              │
           │ (Dispatch offer to provider ASK ME modal)    │
           ▼                                              │
        [OFFERED] ────────────────────────────────────────┤
           │ (Provider accepts offer)                     │
           ▼                                              │
        [LEASED] (Mint monotonic persistent fencing token)│
           │                                              │
           │ (Worker polls & downloads WASM bytecode)     │
           ▼                                              │
      [DISPATCHED]                                        │
           │                                              │
           │ (Worker begins execution in WASI sandbox)    │
           ▼                                              │
       [RUNNING] ─────────────────────────────────────────┘
           │
      ┌────┴─────────────────────────────┐
      │                                  │
 (Worker traps /                    (Execution finishes;
  fuel exhausted)                    stdout & digest ready)
      │                                  │
      ▼                                  ▼
   [FAILED]                         [VERIFYING]
                                         │
                                         │ (Cryptographic receipt verified)
                                         ▼
                                   [AGGREGATING] (For multi-worker DAG shards)
                                         │
                                         │ (All shards deterministically combined)
                                         ▼
                                     [SETTLED]
                                         │ (Double-entry ledger transaction minted)
                                         ▼
                                    [COMPLETED] (Terminal State — Resurrection Blocked)
```

### 2. Authoritative 6-Tuple Node State Model

Eliminates misleading flat scalar states (e.g., "Ready" while blocked on battery). Node state is evaluated dynamically along 6 orthogonal axes:

$$\text{Node State} = \langle \text{Connection}, \text{Enrollment}, \text{Qualification}, \text{Availability}, \text{Eligibility}, \text{Execution} \rangle$$

- **Connection:** `ONLINE` (Heartbeat $\le$ 45s) $\mid$ `OFFLINE` (Heartbeat $>$ 45s)
- **Enrollment:** `UNVERIFIED` $\mid$ `VERIFIED` (Signed Ed25519 pairing token) $\mid$ `REVOKED`
- **Qualification:** `PENDING` $\mid$ `RUNNING` $\mid$ `VERIFIED` (WASI conformance passed) $\mid$ `FAILED` $\mid$ `STALE`
- **Availability:** `AVAILABLE` $\mid$ `BUSY` (Executing job) $\mid$ `PAUSED` (User safety toggle)
- **Eligibility:** `FULL` (All constraints met) $\mid$ `LIMITED` (Battery/Network policy restricted) $\mid$ `NONE`
- **Execution:** `IDLE` $\mid$ `OFFERED` $\mid$ `LEASED` $\mid$ `RUNNING`

---

## 3. Distributed DAG Sharding & Autonomous Recovery Flow

```
                [WORKLOAD SUBMISSION: MATRIX FILTER]
                                 │
                   [PLANNER COST/BENEFIT EVALUATION]
                                 │
        ┌────────────────────────┴────────────────────────┐
        ▼                                                 ▼
[DISTRIBUTION NOT BENEFICIAL]                     [DISTRIBUTION BENEFICIAL]
Transfer + Scheduling > Compute Gain              Parallel Compute Gain > Overhead
Execute on Single Best Node                       Partition into N Shards
                                                          │
                                         ┌────────────────┴────────────────┐
                                         ▼                                 ▼
                                   [SHARD 1]                         [SHARD 2]
                                   Dispatched to                     Dispatched to
                                   Worker A (Phone)                  Worker B (PC)
                                         │                                 │
                                         │ (Worker A Disconnects!)         │
                                         │ Lease expires after 30s         │
                                         ▼                                 │
                                 [AUTONOMOUS FENCE]                        │
                                 Cancel stale lease A                      │
                                 Increment fence token                     │
                                         │                                 │
                                         ▼                                 │
                                [RESCHEDULE SHARD 1]                       │
                                Dispatched to                              │
                                Backup Worker C (PC)                       │
                                         │                                 │
                                         ▼                                 ▼
                                  [SHARD 1 FINISHES]                [SHARD 2 FINISHES]
                                         │                                 │
                                         └────────────────┬────────────────┘
                                                          ▼
                                            [DETERMINISTIC AGGREGATION]
                                            Combines shard outputs into
                                            final verified result digest
                                                          │
                                                          ▼
                                            [EXACTLY-ONCE SETTLEMENT]
```

---

## 4. Balanced Triple-Entry Ledger Invariant

Every compute completion executes an atomic double-entry debit/credit ledger settlement in the coordinator Durable Object SQLite database:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        TRIPLE-ENTRY BALANCE SHEET                      │
├──────────────────────┬───────────────────────┬─────────────────────────┤
│ Transaction Leg      │ Account               │ Amount (TEST CR)        │
├──────────────────────┼───────────────────────┼─────────────────────────┤
│ 1. Consumer DEBIT    │ consumer_enterprise   │ -10.0500 CR             │
│ 2. Provider CREDIT   │ provider_pixel_node   │ +8.5425 CR  (85%)       │
│ 3. Platform CREDIT   │ platform_fee_reserve  │ +1.5075 CR  (15%)       │
├──────────────────────┼───────────────────────┼─────────────────────────┤
│ INVARIANCE CHECK:    │ Net Discrepancy       │  0.0000 CR (BALANCED)   │
└──────────────────────┴───────────────────────┴─────────────────────────┘
```

Mathematical Invariance Guarantee:
$$\text{Gross Customer Debits} = \text{Provider Net Credits} + \text{Platform Fee Revenue}$$
$$\text{Discrepancy} = |\sum \text{Debits} - (\sum \text{Credits} + \sum \text{Fees})| = 0.0000$$

---

## 5. Cross-Cloud Disaster Recovery (DR) Epoch Handoff

```
   [PRIMARY: CLOUDFLARE WORKERS (EPOCH N)]
                      │
                      │ (Normal operation: active heartbeats, leases, jobs)
                      │
                      ▼
   [DISASTER INJECTION / CLOUDFLARE OUTAGE]
                      │
                      ▼
   [FAILOVER TRIGGER: CLOUD RUN DR ACTIVATION]
                      │
                      │ 1. Read last valid /api/v1/dr/checkpoint from backup
                      │ 2. Restore SQLite tables: users, tenants, nodes, jobs, leases, ledger
                      │ 3. POST /api/v1/dr/epoch-handoff:
                      │      target_epoch = N + 1
                      │      target_role  = "ACTIVE_DR"
                      │      fencing_token = "spaas-epoch-(N+1)-active_dr"
                      │
                      ▼
   [STANDBY: CLOUD RUN COORDINATOR (EPOCH N+1)]
                      │
                      │ • Workers reconnect using backoff DNS / fallback URL
                      │ • Workers present epoch N fencing tokens -> rejected (409)
                      │ • Standby re-issues leases under epoch N+1 fencing tokens
                      │ • Jobs resume from last durable checkpoint
                      │ • Exactly-once ledger settlement preserved
                      │
                      ▼
   [PRIMARY RECOVERY & CONTROLLED FAILBACK]
                      │
                      │ 1. Export checkpoint from Cloud Run (Epoch N+1)
                      │ 2. Import checkpoint into Cloudflare Durable Object
                      │ 3. Increment epoch to N + 2
                      │ 4. Cloudflare resumes primary role with epoch N + 2 fencing tokens
```
