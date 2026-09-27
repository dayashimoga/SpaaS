# ADR-007: Auditable Double-Entry Test Credit Accounting & Simulation Data Isolation

**Status:** Accepted  
**Date:** 2026-09-27  
**Deciders:** Principal Distributed Systems Architect, DevSecOps Lead, Product UX Designer  

## Context
Previous iterations of edge compute platforms often suffered from two major integrity flaws:
1. **Simulation Contamination:** Test cluster nodes and synthetic jobs mingled with real physical smartphone metrics, presenting fabricated fleet capacities.
2. **Ambiguous or Vulnerable Metering:** Ad-hoc increment/decrement counters allowed race conditions, double-spending, or gave the false impression of real monetary payouts.

## Decision
We enforce **Strict Simulation Data Isolation and Cryptographic Double-Entry Accounting**:
1. **Auditable Double-Entry Ledger:**
   - All resource usage is settled in **TEST CREDITS** using formal double-entry bookkeeping (`crates/metering` and Cloudflare DO SQLite `ledger` table).
   - Every settlement transaction consists of matching debit and credit entries:
     - `DEBIT: Consumer Account (Workload Submitter)`
     - `CREDIT: Provider Account (Device Owner)`
     - `CREDIT: Protocol Infrastructure Fee (Nominal network burn)`
   - Every transaction requires a unique cryptographic `idempotency_key = SHA256(job_id || epoch || result_digest)`. Duplicate submissions are idempotent no-ops.
2. **Transparent Resource Unit Tariffs:**
   - Test credit settlement is strictly calculated from verified metrics:
     `Credits = (Fuel / 1,000,000) * Tariff_CPU + (RAM_MB * Duration_Sec / 3600) * Tariff_RAM + (Network_KB) * Tariff_Net`
   - UI displays itemized formula breakdowns for every completed job.
3. **Explicit "TEST CREDITS" Labeling:**
   - The platform explicitly labels all balances and rewards as **TEST CREDITS** with zero monetary value or fiat redemption claims.
4. **Strict Simulation Isolation:**
   - Production views (Overview, Devices, Workloads, Jobs) strictly exclude nodes with `is_simulated == true`.
   - Simulation mode is isolated to a dedicated namespace with a prominent visual banner ("SIMULATION MODE ACTIVE").
   - Web Console provides an instant `[Purge Simulated Fleet]` action (`POST /api/v1/demo/purge-simulated-nodes`) to wipe synthetic data and maintain a pristine real-hardware view.

## Consequences
### Positive:
- 100% auditable accounting with mathematical conservation of balances.
- Prevents double-spending and race conditions during concurrent settlement.
- Ensures total integrity of public platform metrics: what users see is 100% genuine physical edge capacity.

### Negative / Trade-offs:
- Slightly higher database storage per job due to itemized double-entry transaction rows.
