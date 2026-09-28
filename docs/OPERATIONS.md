# SPaaS Universal Edge Fabric — Standard Operating Procedures (SOP) & Operations Runbook

## 1. System Overview & Architecture

The Smartphone-as-a-Service (SPaaS) production infrastructure consists of a multi-cloud, dual-redundant topology:

```
                                  [ Internet / Edge Clients ]
                                                │
                     ┌──────────────────────────┴──────────────────────────┐
                     ▼                                                     ▼
    [ Cloudflare Workers Primary Ingress ]              [ Cloud Run Cold Standby (GCP) ]
    • Anycast DNS: spaas-control-plane.workers.dev       • Auto-scaling 0-min instances
    • SQLite Durable Object (ctx.storage.sql)           • Embedded RocksDB / SQLite WAL
    • Active Fencing Epoch: 1                            • Standby Fencing Epoch: 1
    • Dynamic Placement & Double-Entry Ledger            • Checkpoint Sync Target
                     │                                                     │
                     └──────────────────────────┬──────────────────────────┘
                                                │
                                 [ Enrolled Edge Compute Nodes ]
                                 • Android 10+ Physical Smartphones
                                 • Heterogeneous Desktop Edge Workers
```

---

## 2. Daily Health Probing & Metrics Inspection

### 2.1 Primary Health Probes
Execute standard HTTP GET request against the health endpoint:
```bash
curl -s -i https://spaas-control-plane.dayashimoga.workers.dev/health
```
**Expected Response (HTTP 200 OK):**
```json
{
  "status": "healthy",
  "service": "spaas-cloudflare-control-plane",
  "version": "0.2.0-prod",
  "role": "PRIMARY",
  "epoch": 1,
  "fabric_status": "ACTIVE",
  "subsystems": {
    "gateway": "HEALTHY",
    "control_plane": "HEALTHY",
    "scheduler": "HEALTHY",
    "persistence": "DURABLE_SQLITE_HEALTHY",
    "worker_channel": "WEBSOCKET_HIBERNATION_READY"
  }
}
```

### 2.2 Prometheus Metrics Scraping
For telemetry collection and Grafana ingestion:
```bash
curl -s https://spaas-control-plane.dayashimoga.workers.dev/metrics
```

Key operational metrics to monitor:
- `spaas_active_nodes`: Current enrolled, responsive edge devices.
- `spaas_queue_depth`: Jobs queued pending scheduling.
- `spaas_avg_scheduling_latency_ms`: Scheduler selection latency (target: < 2.0ms).
- `spaas_failed_jobs_total`: Count of failed/evicted workloads.

---

## 3. Node Lifecycle & Zero-Synthetic Fleet Management

### 3.1 Generating Single-Use Pairing Credentials
Admins or operators generate ephemeral 6-character onboarding tokens via the Web Console or CLI:
```bash
curl -s -X POST https://spaas-control-plane.dayashimoga.workers.dev/api/v1/devices/pairing-token \
  -H "Authorization: Bearer <SPAAS_ADMIN_SECRET>"
```
**Response:**
```json
{
  "code": "729401",
  "expires_in_secs": 600,
  "qr_payload": "spaas://pair?code=729401&primary=https%3A%2F%2Fspaas-control-plane.dayashimoga.workers.dev"
}
```

### 3.2 Pruning Revoked Devices
To clean up decommissioned or revoked nodes from the cluster fabric:
```bash
curl -s -X DELETE https://spaas-control-plane.dayashimoga.workers.dev/api/v1/nodes/prune-revoked \
  -H "Authorization: Bearer <SPAAS_ADMIN_SECRET>"
```

### 3.3 Zero-Synthetic Cluster Reset
To purge all simulated demonstration nodes and reset the fabric to strictly genuine physical hardware:
```bash
curl -s -X POST https://spaas-control-plane.dayashimoga.workers.dev/api/v1/demo/purge-simulated-nodes \
  -H "Authorization: Bearer <SPAAS_ADMIN_SECRET>"
```

---

## 4. Double-Entry Ledger & Financial Settlement Reconciliation

All compute consumption and provider payouts are recorded in an atomic, append-only double-entry ledger.

### 4.1 Exporting Ledger as CSV
To export all settled transactions for auditing, accounting, and compliance:
```bash
curl -s -H "Authorization: Bearer <SPAAS_ADMIN_SECRET>" \
  https://spaas-control-plane.dayashimoga.workers.dev/api/v1/ledger/download \
  -o spaas-ledger-export.csv
```

### 4.2 Verifying Transaction Invariants
Every completed job must contain two paired rows sharing the same `tx_id`:
1. `entry_type = DEBIT`: Deducts TEST CREDITS from the submitting consumer.
2. `entry_type = CREDIT`: Awards TEST CREDITS to the compute provider node.

---

## 5. Deployment Procedures

### 5.1 Cloudflare Worker (Primary Control Plane)
```bash
cd apps/cloudflare-control-plane
npm ci
npm test
npx wrangler deploy
```

### 5.2 Cloudflare Pages (Web Console)
```bash
cd apps/web-console
npm ci
npm run build
npx wrangler pages deploy dist --project-name=spaas-console --commit-dirty=true
```

### 5.3 Google Cloud Run Standby Container
```bash
podman build -t gcr.io/spaas-production/spaas-control-plane:latest -f Dockerfile .
gcloud run deploy spaas-control-plane-standby \
  --image gcr.io/spaas-production/spaas-control-plane:latest \
  --region us-central1 \
  --min-instances 0 \
  --max-instances 5 \
  --allow-unauthenticated \
  --set-env-vars SPAAS_ROLE=STANDBY,SPAAS_CONTROL_PLANE_EPOCH=1
```

---

## 6. Disaster Recovery: Failover & Failback Playbooks

### 6.1 Emergency Promotion of Cloud Run Standby
If Cloudflare experiences a global edge outage:

1. **Activate Standby Authority**:
   ```bash
   curl -s -X POST https://<cloud-run-endpoint>/api/v1/dr/activate \
     -H "Authorization: Bearer <SPAAS_ADMIN_SECRET>"
   ```
2. **Result**:
   - Cloud Run increments the monotonic `epoch` (e.g. from `1` to `2`).
   - Issues a new cryptographically signed fencing token.
   - Enrolled Android nodes automatically fail over after 3 consecutive connection timeouts.

### 6.2 Failback Authority Transfer
Once Cloudflare recovers:

1. Export the latest checkpoint from Cloud Run:
   ```bash
   curl -s -H "Authorization: Bearer <SPAAS_ADMIN_SECRET>" \
     https://<cloud-run-endpoint>/api/v1/dr/checkpoint > dr-checkpoint.json
   ```
2. Ingest checkpoint into Cloudflare Worker and increment epoch:
   ```bash
   curl -s -X POST -d @dr-checkpoint.json \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer <SPAAS_ADMIN_SECRET>" \
     https://spaas-control-plane.dayashimoga.workers.dev/api/v1/dr/checkpoint
   ```
3. Deactivate Cloud Run standby:
   ```bash
   curl -s -X POST https://<cloud-run-endpoint>/api/v1/dr/deactivate \
     -H "Authorization: Bearer <SPAAS_ADMIN_SECRET>"
   ```
4. Android nodes detect primary resumption on periodic background probe and automatically fail back.
