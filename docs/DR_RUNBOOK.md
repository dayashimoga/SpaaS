# SPaaS Disaster Recovery (DR) & Business Continuity Runbook

## 1. Architectural Overview & Standby Topology

The SPaaS Universal Edge Compute Fabric implements a multi-cloud, active-to-cold-standby disaster recovery architecture designed to survive severe edge provider outages:

```
[ Primary: Cloudflare Edge ]
Pages (UI) + Workers (API Gateway) + SQLite Durable Objects (Authoritative Epoch N)
             │
             │ Periodic / Event-Driven State Checkpoint Replication
             ▼
[ Cold Standby: Google Cloud Run ]
Rust / Axum Engine + Local SQLite / Cloud Storage (Standby Epoch N+1)
```

- **Primary Control Plane**: Cloudflare Pages + Workers + SQLite Durable Objects (Epoch $N$).
- **Backup Control Plane**: Google Cloud Run running native Rust/Axum service (Epoch $N+1$).
- **State Authority**: Durable Object SQLite is authoritative during Epoch $N$. Standby is read-only until promoted to Epoch $N+1$.

---

## 2. Recovery Objectives & Invariants

| Metric | Target SLA | Verification Method |
|---|---|---|
| **RPO (Recovery Point Objective)** | $\le 5$ seconds | Checkpoint export interval + write-ahead transaction log. |
| **RTO (Recovery Time Objective)** | $\le 30$ seconds | Container cold-start promotion and DNS failover. |
| **Split-Brain Invariant** | 0 Split Brains | Monotonic epoch fencing tokens strictly reject late requests from older epochs. |
| **Ledger Invariant** | $\Delta = 0.0000\text{ CR}$ | Double-entry balance identity ($\sum \text{Debits} \equiv \sum \text{Credits}$) preserved across failover. |

---

## 3. Checkpoint Replication Payload

The complete authoritative state is serialized via `GET /api/v1/dr/checkpoint`:

```json
{
  "checkpoint_id": "cp_20261008_170000",
  "epoch": 42,
  "timestamp": 1791459600000,
  "tables": {
    "users": [ ... ],
    "tenants": [ ... ],
    "nodes": [ ... ],
    "jobs": [ ... ],
    "leases": [ ... ],
    "idempotency_keys": [ ... ],
    "device_sessions": [ ... ],
    "ledger": [ ... ]
  },
  "signature": "ed25519_signature_of_checkpoint_digest"
}
```

Every table required for seamless failover is replicated:
- **`users` & `tenants`**: Authentication credentials, password hashes, and tenant policy quotas.
- **`nodes`**: Active device enrollments, Ed25519 public keys, and 6-tuple states.
- **`jobs` & `leases`**: Active job states, execution fuel budgets, and active worker lease bindings.
- **`idempotency_keys`**: Request deduplication cache to prevent replay mutations.
- **`ledger`**: Double-entry financial records with fee policy version tags.

---

## 4. Phase-by-Phase Failover Procedure (Cloudflare $\to$ Cloud Run)

### Phase 1: Incident Confirmation & Declaration
1. On-call SRE detects widespread Cloudflare Workers / DO failure via external synthetics (P99 latency > 5s or 5xx error rate > 50% for 60s).
2. SRE Lead authorizes DR failover:
   ```bash
   export DR_INCIDENT_ID="INC-2026-10-08-CF-OUTAGE"
   ```

### Phase 2: Epoch Increment & Monotonic Fencing
1. If Cloudflare is partially reachable, trigger graceful handoff:
   ```bash
   curl -X POST https://api.spaas.network/api/v1/dr/epoch-handoff \
     -H "Authorization: Bearer <SUPER_ADMIN_TOKEN>" \
     -d '{"target_epoch": 43, "standby_target": "gcp-cloud-run"}'
   ```
2. If Cloudflare is completely unreachable, Standby unilaterally advances epoch:
   ```
   Standby Epoch = Last_Known_Epoch + 1  (e.g., 42 -> 43)
   ```
3. Standby validates epoch fencing: Any request presenting an Epoch 42 token is immediately rejected with `409 Conflict: STALE_EPOCH`.

### Phase 3: Standby Promotion & State Hydration
1. Google Cloud Run container spins up from cold standby:
   ```bash
   gcloud run services update spaas-standby-engine \
     --region us-central1 \
     --min-instances 2 \
     --set-env-vars "SPaaS_ACTIVE_EPOCH=43,SPaaS_STATE_SOURCE=r2_snapshot_latest"
   ```
2. Axum engine executes `spaas_persistence::hydrate_from_checkpoint()`:
   - Hydrates SQLite schema.
   - Validates ledger balance: $\sum \text{Debits} == \sum \text{Credits}$.
   - Marks interrupted jobs as `RESCHEDULE_PENDING`.

### Phase 4: Ingress DNS & WebSocket Failover
1. Update DNS record (`api.spaas.network`) to point to Cloud Run CNAME:
   ```bash
   # Automated via Cloudflare API or Route53 secondary DNS
   curl -X PATCH https://api.dns-provider.com/records/api.spaas.network \
     -d '{"content": "spaas-standby-engine-uc.a.run.app"}'
   ```
2. Edge workers (Android and Desktop) detect WebSocket disconnect, enter exponential backoff (1s, 2s, 4s, 8s), and reconnect to new IP.
3. Workers authenticate using their stored device private key. Standby verifies the public key from the hydrated `nodes` table and issues an Epoch 43 session lease.

---

## 5. Phase-by-Phase Failback Procedure (Cloud Run $\to$ Cloudflare)

Once Cloudflare edge services are declared healthy:

### Phase 1: Snapshot Standby Delta
1. Freeze job submissions on Cloud Run standby:
   ```bash
   curl -X POST https://standby.spaas.network/api/v1/system/emergency-stop \
     -H "Authorization: Bearer <STANDBY_ADMIN_TOKEN>"
   ```
2. Export complete delta checkpoint from Cloud Run:
   ```bash
   curl https://standby.spaas.network/api/v1/dr/checkpoint > failback_checkpoint_epoch43.json
   ```

### Phase 2: Re-Hydrate Cloudflare Durable Object (Epoch 44)
1. Restore Durable Object state with target Epoch 44:
   ```bash
   curl -X POST https://primary-staging.spaas.network/api/v1/dr/restore \
     -H "Authorization: Bearer <SUPER_ADMIN_TOKEN>" \
     -H "Content-Type: application/json" \
     -d @failback_checkpoint_epoch43.json
   ```

### Phase 3: DNS Switch & Verification
1. Re-point `api.spaas.network` to Cloudflare Pages & Workers.
2. Verify system health and double-entry reconciliation:
   ```bash
   curl https://api.spaas.network/api/v1/billing/reconciliation
   ```
3. Scale Cloud Run standby back to zero (`min-instances = 0`).

---

## 6. Post-Recovery Verification Checklist

- [ ] All customer balances reconciled with zero discrepancy ($\Delta = 0.0000\text{ CR}$).
- [ ] Fee policy version (`v1.0-85_15`) intact across all transactions.
- [ ] No in-flight jobs permanently orphaned; interrupted tasks completed or refunded.
- [ ] Android and Desktop workers successfully reconnected without manual re-pairing.
- [ ] Post-incident report filed with exact RPO and RTO timestamps.
