# SPaaS Cluster & Platform Administrator Guide

## 1. Executive Overview & Administrative Architecture

Smartphone-as-a-Service (SPaaS) provides platform administrators, operations engineers, and security auditors with centralized governance, fleet lifecycle orchestration, multi-tenant policy enforcement, and financial integrity auditing over the distributed edge compute mesh.

The administration control plane is anchored in Cloudflare Workers backed by transactional SQLite Durable Objects, providing authoritative ACID state with zero external database dependencies.

---

## 2. Role-Based Access Control (RBAC) & Least-Privilege Boundaries

SPaaS enforces a strict, deny-by-default role registry across all 65+ API routes and WebSocket endpoints. Administrative capabilities are segmented across four primary governance roles:

| Role Identifier | Description | Allowed Administrative Capabilities | Forbidden Actions |
|---|---|---|---|
| `SUPER_ADMIN` | Platform Owner | Full administrative authority across all tenants, nodes, jobs, billing configurations, and DR epoch handoffs. | None (Break-glass access). |
| `OPS` | Infrastructure Operations | Node management (drain, unenroll, delete), emergency stop, scheduler tuning, queue purging, DR checkpoint trigger. | Cannot alter billing configurations or initiate customer balance deductions. |
| `SECURITY` | Security & Compliance Auditor | Read-only threat intelligence, audit log queries, active session inspection, certificate/token validation. | **Strictly forbidden from node deletion, workload submission, device pairing, or financial modification.** |
| `FINANCE` | Billing & Revenue Auditor | Dual-entry ledger audits, fee policy version inspection, customer credit adjustments, reconciliation discrepancy verification. | Cannot drain nodes, cancel running jobs, or alter scheduling algorithms. |

### 2.1 Enforced Security Role Boundary
In accordance with least-privilege principles, the `SECURITY` role is isolated from compute and infrastructure control:
- In the API: `DELETE /api/v1/nodes/:id` and `POST /api/v1/system/emergency-stop` strictly require `SUPER_ADMIN` or `OPS`. Requests from `SECURITY` return `403 Forbidden`.
- In the Web Console: Node deletion, emergency stop, and workload submission controls are completely hidden from the DOM tree when logged in as `SECURITY`.

---

## 3. First-Owner Bootstrap & Identity Lifecycle

SPaaS ships with zero hardcoded default administrator credentials in production. Initial cluster bootstrapping follows a secure one-time token protocol.

### 3.1 Initial Cluster Bootstrap
1. When a new cluster initializes with zero users, the Durable Object coordinator generates a cryptographically secure, single-use bootstrap token:
   ```
   spaas_boot_<random_64_char_hex>
   ```
2. The token is logged to secure coordinator initialization logs with a 15-minute TTL.
3. The platform owner executes the bootstrap request:
   ```bash
   curl -X POST https://api.spaas.network/api/v1/auth/bootstrap \
     -H "Content-Type: application/json" \
     -d '{
       "bootstrap_token": "spaas_boot_8f9a2b...",
       "admin_email": "owner@enterprise.com",
       "admin_password": "SuperSecurePassword123!"
     }'
   ```
4. Upon successful initialization:
   - The owner account is minted with `SUPER_ADMIN` role.
   - The bootstrap token is permanently hashed and invalidated.
   - Any subsequent call to `/api/v1/auth/bootstrap` returns `409 Conflict: Cluster already bootstrapped`.

### 3.2 Account Locking & Break-Glass Recovery
- **Brute-Force Protection**: 5 consecutive failed login attempts trigger an automated 15-minute account lock.
- **Admin Unlock**: An administrator can manually unlock an account via:
  ```bash
  curl -X POST https://api.spaas.network/api/v1/admin/users/unlock \
    -H "Authorization: Bearer <ADMIN_SESSION_TOKEN>" \
    -H "Content-Type: application/json" \
    -d '{"email": "locked_user@enterprise.com"}'
  ```

---

## 4. Multi-Tenant Isolation & Quota Guard

Every customer and enterprise account operates within an isolated tenant partition (`tenant_id`).

### 4.1 Tenant Boundaries
- **Idempotency Keys**: Scoped per tenant in the DO SQLite `idempotency_keys` table.
- **Artifact Plane**: R2 artifacts are partitioned by `/artifacts/:tenantId/:sha256`. Cross-tenant artifact reads return `403 Forbidden`.
- **Telemetry & Traces**: `/jobs/:id/trace` and `/observability/trace/:id` strictly reject requests from callers outside the job's owning tenant.

### 4.2 Cloudflare Quota Guard
The built-in Quota Guard continuously monitors free and paid tier operation limits:
- **Daily Budget per Active Device**: 2,880 operations/day (heartbeat every 30s).
- **Free Tier Ceiling**: 34 concurrent edge devices (100,000 DO requests/day limit).
- **Paid Tier Capacity**: Up to 3,470 active devices per standard Workers Unbound quota pool.
- **Threshold Alerts**:
  - `WARN` at 80% quota utilization (initiates heartbeat backpressure: 30s -> 60s).
  - `CRITICAL` at 95% quota utilization (suspends non-essential telemetry logging).

---

## 5. Edge Fleet Management & Lifecycle Operations

Administrators can monitor and orchestrate physical smartphones, emulators, desktops, and simulated workers from the **Fleet Management** console.

### 5.1 Device 6-Tuple State
Every node is evaluated along an authoritative 6-tuple state vector:
1. `Connection`: `Online` (heartbeat <60s) or `Offline`.
2. `Enrollment`: `Active`, `Draining`, or `Revoked`.
3. `Qualification`: `Benchmarked` (MIPS verified) or `Unverified`.
4. `Availability`: `Charging_Unmetered`, `Battery_Discharging`, or `Unavailable`.
5. `Eligibility`: Boolean indicating if device meets current job constraints.
6. `Execution`: `Idle`, `Leased`, `Running`, or `Yielded`.

### 5.2 Node Drain & Deletion
- **Drain Node**: Prevents the scheduler from assigning new leases while allowing active jobs to finish:
  ```bash
  curl -X POST https://api.spaas.network/api/v1/nodes/:id/drain \
    -H "Authorization: Bearer <ADMIN_TOKEN>"
  ```
- **Unenroll/Delete Node**: Permanently revokes the device pairing token and terminates active WebSocket channels:
  ```bash
  curl -X DELETE https://api.spaas.network/api/v1/nodes/:id \
    -H "Authorization: Bearer <ADMIN_TOKEN>"
  ```

---

## 6. Financial Ledger & Revenue Integrity

SPaaS maintains an authoritative double-entry accounting ledger inside Durable Object SQLite.

### 6.1 Balanced Double-Entry Invariant
Every settled compute task writes two atomic entries:
1. **DEBIT**: Deducts `amount_credits` from the Customer's balance.
2. **CREDIT**: Credits `amount_credits` to the Provider's balance, storing platform fee margin in `platform_fee_credits`.

**Mathematical Invariant**:
$$\sum \text{Total Debits} \equiv \sum \text{Total Credits} \quad (\Delta \text{Discrepancy} \equiv 0.0000 \text{ CR})$$

### 6.2 Fee Policy Versioning
Platform fee splits are explicitly versioned on every ledger transaction:
- `v1.0-85_15`: Production standard (85% provider payout / 15% platform margin).
- `v0.9-90_10`: Legacy pilot policy (90% provider payout / 10% platform margin).

### 6.3 Reconciling Ledger Integrity
Administrators can verify ledger consistency at any time:
```bash
curl https://api.spaas.network/api/v1/billing/reconciliation \
  -H "Authorization: Bearer <FINANCE_OR_ADMIN_TOKEN>"
```
Expected response:
```json
{
  "total_gross_debits": "150.0000",
  "total_provider_credits": "127.5000",
  "total_platform_fee_credits": "22.5000",
  "discrepancy_credits": "0.0000",
  "fee_policy_version": "v1.0-85_15",
  "reconciliation_status": "BALANCED"
}
```

---

## 7. Emergency Incident Response & Platform Recovery

### 7.1 Emergency Stop
If a malicious workload or abnormal network traffic is detected, administrators can trigger an instant fabric-wide freeze:
```bash
curl -X POST https://api.spaas.network/api/v1/system/emergency-stop \
  -H "Authorization: Bearer <OPS_OR_SUPER_ADMIN_TOKEN>"
```
**Effect**:
- Halts all scheduler dispatches.
- Broadcasts emergency pause frames to all connected WebSockets.
- Enters read-only mode for job submissions.

### 7.2 Disaster Recovery Handoff
To transfer authoritative state to the Google Cloud Run standby during a Cloudflare regional incident, follow the [Disaster Recovery Runbook](file:///h:/SpaaS/docs/DR_RUNBOOK.md).
