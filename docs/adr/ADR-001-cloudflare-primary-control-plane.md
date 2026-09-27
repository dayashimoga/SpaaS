# ADR-001: Cloudflare Pages + Workers + SQLite-backed Durable Objects as Primary Control Plane

**Status:** Accepted  
**Date:** 2026-09-27  
**Deciders:** Principal Distributed Systems Architect, Cloudflare Specialist, DevSecOps Lead  

## Context
SPaaS originally implemented its control plane as a stateful Axum Rust process with local filesystem storage (`spaas.wal` Write-Ahead Log). When deploying the Web Console to Cloudflare Pages (`https://...pages.dev`), two critical problems arose:
1. **Mixed Active Content:** Browsers strictly block unencrypted HTTP calls from HTTPS origins, requiring a local Cloudflare Tunnel daemon to expose port 8080.
2. **Availability & Serverless Scaling:** Requiring an engineer's laptop or dedicated virtual machine to continuously run the Axum process created a single point of failure and prevented autonomous, globally distributed operation.

## Decision
We designate **Cloudflare Pages + Workers + Durable Objects** as the **Primary Production Control Plane**:
1. **Frontend:** Cloudflare Pages hosts the static Web Console SPA, offering global CDN caching, sub-second TTFB, and zero maintenance.
2. **Public API Ingress:** Cloudflare Workers handles public HTTPS requests (`/api/v1/*`), routing, TLS termination, CORS, and IP-based rate limiting.
3. **Stateful Coordination:** Partitioned SQLite-backed Durable Objects (`CoordinatorDO`) manage authoritative state using `ctx.storage.sql`.
4. **Zero-Cost Worker Connectivity:** Utilize the Cloudflare **WebSocket Hibernation API** (`ctx.acceptWebSocket(ws)`). When thousands of mobile phones connect, idle WebSockets are hibernated without consuming CPU or memory quotas.
5. **Event-Driven Reconciliation:** Durable Object Alarms (`ctx.storage.setAlarm(timestamp)`) periodically wake up the DO to sweep expired leases and reschedule orphaned workloads, eliminating permanently running worker threads.

## Consequences
### Positive:
- 100% serverless: No permanently running virtual machines or laptops required.
- High availability with global Anycast edge routing.
- ACID transactions with SQLite in Durable Objects, eliminating corruptible flat files.
- Generous free-tier limits: 100,000 Worker requests/day, 1,000,000 DO requests/month.
- Eliminates browser mixed-content barriers.

### Negative / Trade-offs:
- Requires porting state machine logic and schema to JavaScript/TypeScript/WASM within the Cloudflare Worker runtime.
- Protocol compatibility with Rust clients must be rigorously maintained via versioned JSON schemas.
