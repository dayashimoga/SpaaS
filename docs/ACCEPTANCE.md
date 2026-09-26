# SPaaS Production Acceptance Gate Specification

## 1. Single Command Production Acceptance Gate
The command:
```powershell
.\scripts\acceptance.ps1 -Full    # Windows PowerShell
./scripts/acceptance.sh --full    # Linux / macOS POSIX Shell
```
is the authoritative single-command gating mechanism for certifying release readiness across the SPaaS Universal Edge Compute Fabric. Any release build must pass all mandatory verification gates without bypass or manual intervention.

---

## 2. Mandatory Verification Gates & Exit Criteria

| Gate ID | Gate Name | Subsystem | Pass Criteria & Verification Threshold |
|---|---|---|---|
| **GATE-01** | Clean Compilation & Lint | All Rust Crates | `cargo check --workspace --all-targets` and `cargo clippy --workspace --all-targets -- -D warnings` must complete with exit code 0 and zero warnings. |
| **GATE-02** | Cryptographic Integrity | `crates/security` | 100% pass on Ed25519 key generation, canonical payload signing, SHA-256 digest validation, and rejection of mutated signatures. |
| **GATE-03** | Deterministic WASM Sandbox | `crates/runtime` | Strict fuel consumption ceilings; guaranteed termination of unbounded loops (`wasm_gas_metering`); zero memory leaks or host process corruption. |
| **GATE-04** | Multi-Attribute Scheduler | `crates/scheduler-core` | Pareto-efficient scoring across MIPS, battery level, thermal margin, network RTT, provider reliability, cost, and geographical affinity. |
| **GATE-05** | Zero-Trust Security Suite | `crates/security`, Control Plane | Defense-in-depth verification: prevention of signature forgery, replay protection using monotonic nonces, and lease-token verification. |
| **GATE-06** | Node Disappearance Resilience | Reconciler & Scheduler | Autonomous detection of node dropouts within `heartbeat_timeout_ms` (10s), lease forfeiture, and rescheduling without job loss. |
| **GATE-07** | E2E Execution & Accounting | Control Plane & Metering | Full loop: Workload dispatch -> Node lease acquisition -> Sandboxed execution -> Signed result submission -> Ledger credit deduction. |
| **GATE-08** | Web Production Bundle | `apps/web-console` | Zero-error Vite compilation (`npm run build`); generation of minified HTML/CSS/JS with sub-second asset bundling and zero broken dependencies. |
| **GATE-09** | Live Microservice Smoke | Control Plane Server | Live daemon startup, `/health` endpoint returning 200 OK, SSE heartbeat streaming, and successful simulated or physical node enrollment. |
| **GATE-10** | Certification Report | Release Automation | Automated generation of machine-readable `acceptance-report.json` with timestamped cryptographic hashes of all binary artifacts. |

---

## 3. Evidence Classification Taxonomy

Every capability claim and platform requirement in SPaaS is audited against a four-tier classification system:

- **PROVEN**: Functionality verified on physical target platforms (e.g., physical ARM64 Android smartphones, x86_64 desktop nodes) with empirical telemetry logs.
- **SIMULATION-PROVEN**: Functionality validated inside the distributed simulation framework with reproducible synthetic network latency, thermal throttling, and battery drain.
- **IMPLEMENTED-UNPROVEN**: Production code is complete, compiled, and unit/integration tested; pending physical deployment on specialized external testbeds.
- **HARDWARE-REQUIRED**: Feature relies on proprietary vendor hardware or specialized virtualization extensions (e.g., Qualcomm Hexagon NPU, Android Virtualization Framework pKVM, ARM TrustZone hardware keystore).

---

## 4. Acceptance Report Artifact Schema

Upon completion of the acceptance runner, a structured certification artifact is produced at `dist/acceptance-report.json`:

```json
{
  "spaas_version": "0.1.0",
  "git_commit": "abcdef123456...",
  "timestamp_utc": "2026-09-26T12:00:00Z",
  "overall_verdict": "PASSED",
  "gates": [
    {
      "id": "GATE-01",
      "name": "Clean Compilation",
      "status": "PASSED",
      "duration_ms": 1420,
      "details": "0 errors, 0 warnings across 12 workspace crates"
    },
    {
      "id": "GATE-07",
      "name": "End-to-End Lifecycle",
      "status": "PASSED",
      "duration_ms": 2840,
      "details": "Submitted job settled, 100 TEST CREDITS transferred"
    }
  ],
  "artifact_hashes": {
    "control_plane_sha256": "...",
    "node_agent_sha256": "...",
    "web_console_sha256": "..."
  }
}
```

---

## 5. Release Sign-Off Procedure
1. Execute the full acceptance gate: `.\scripts\acceptance.ps1 -Full`.
2. Inspect `dist/acceptance-report.json` and ensure `"overall_verdict": "PASSED"`.
3. Verify that zero gates contain `FAILED` or `SKIPPED` status.
4. Archive the acceptance report alongside release binaries in version control tags.
