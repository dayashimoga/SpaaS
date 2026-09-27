# ADR-003: Control-Plane Epochs, Fencing Tokens, and Controlled Failover/Failback Protocol

**Status:** Accepted  
**Date:** 2026-09-27  
**Deciders:** Principal Distributed Systems Architect, DevSecOps Lead, QA Lead  

## Context
When maintaining a multi-cloud active-standby topology (Cloudflare Primary + Google Cloud Run Standby), the most severe catastrophic failure mode is a **split-brain condition**: both control planes concurrently scheduling jobs, assigning conflicting leases to devices, or minting duplicate test credits to ledgers. Automated failover based purely on timeout heuristics can trigger false failovers during transient network partitions.

## Decision
We enforce a strict **Epoch-Based Fencing Protocol**:
1. **Monotonic Epochs:** Platform state includes a monotonically increasing `control_plane_epoch` (integer).
   - Normal operation on Cloudflare: `Epoch 1`.
   - Upon failover promotion to Cloud Run: `Epoch 2`.
   - Upon failback return to Cloudflare: `Epoch 3`.
2. **Fencing Tokens in Job Leases:** Every job lease dispatched to an edge node contains `(job_id, lease_term, epoch, fencing_token)`. Nodes must return this fencing token with results. Any result submitted with an epoch lower than the current active epoch is rejected immediately with `HTTP 409 Conflict (STALE_EPOCH_FENCED)`.
3. **Controlled, Operator-Approved Activation:** Automatic failover without human or quorum authorization is prohibited. In an outage, an authorized operator issues a cryptographically authenticated command: `POST /api/v1/dr/activate` with `Authorization: Bearer <SPAAS_DR_ACTIVATION_KEY>`.
4. **Idempotent Settlement Ledger:** Transactions in the credit ledger are uniquely identified by `(idempotency_key, epoch, job_id)`. The ledger enforces uniqueness at the database constraint level, preventing duplicate credit allocation across epochs.
5. **Safe Failback Reconciliation:** When Cloudflare recovers, the operator triggers `POST /api/v1/dr/failback`. Cloud Run generates an authenticated delta snapshot, marks itself dormant (`STANDBY`), and Cloudflare imports the delta, increments the epoch, and reclaims authoritative leadership.

## Consequences
### Positive:
- Mathematically proves zero split-brain and zero double-settlement.
- Clear audit trail of all control plane transitions.
- Eliminates risk of automated thrashing during flaky network partitions.

### Negative / Trade-offs:
- Requires operator intervention to initiate failover, trading sub-second RTO for absolute accounting correctness.
