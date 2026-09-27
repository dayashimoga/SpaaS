# ADR-002: Google Cloud Run with Independent Storage as Cold Standby Disaster Recovery

**Status:** Accepted  
**Date:** 2026-09-27  
**Deciders:** Principal Distributed Systems Architect, Google Cloud Specialist, SRE Lead  

## Context
Relying entirely on a single cloud vendor (Cloudflare) introduces a catastrophic failure domain if a global Cloudflare outage, BGP routing anomaly, or account suspension occurs. The platform requires an independent, cross-cloud disaster recovery control plane.

## Decision
We deploy the existing Axum Rust control plane (`apps/control-plane`) to **Google Cloud Run** as a **Cold Standby**:
1. **Cold Standby Scaling:** Set `min-instances: 0` and `max-instances: 10`. While dormant, zero compute cost is incurred.
2. **Authoritative Exclusivity:** During normal operations, Cloudflare DO is the ONLY authoritative control plane. The Cloud Run standby instance runs in a dormant mode (`SPAAS_ROLE=STANDBY`), rejecting job submissions and credit settlement with `HTTP 412 Precondition Failed` or `HTTP 503 Service Unavailable`.
3. **Independent Reachability:** The standby control plane is hosted on an independent domain (e.g. `https://spaas-dr.a.run.app`), completely decoupled from Cloudflare's DNS, edge network, and SSL certificates.
4. **Backup Web Interface:** The Cloud Run container directly serves a mirrored instance of the Web Console SPA, guaranteeing operator and user access even if Cloudflare Pages is completely unreachable.
5. **Periodic Checkpoint Priming:** The standby instance ingests authenticated state checkpoints (`/api/v1/dr/checkpoint`) signed by the Primary control plane, ensuring recovery point objectives (RPO < 60s) are met.

## Consequences
### Positive:
- True cloud diversity: Survives complete Cloudflare outages.
- Zero idle costs on Google Cloud Run (2M free requests/mo, 360,000 vCPU-seconds).
- Preserves the high-performance Rust control plane implementation.
- Provides independent observability and out-of-band operator controls.

### Negative / Trade-offs:
- Cold start delay (~2-4 seconds) upon initial failover activation.
- Requires strict synchronization protocols to prevent split-brain execution (addressed in ADR-003).
