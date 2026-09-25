# SPaaS Comprehensive Testing Framework

## 1. Testing Philosophy
SPaaS enforces a 100% test pass rate with strict coverage verification across all core distributed systems, cryptographic, runtime, and scheduling components.

---

## 2. Test Suites Overview

### 2.1 Unit Tests
- `spaas-protocol`: Validates legal and illegal state transitions, serialization roundtrips, and evidence rules.
- `spaas-security`: Validates Ed25519 key generation, signing, verification, SHA-256 checks, token claims, and sanitization.
- `spaas-runtime`: Verifies WebAssembly module loading, gas fuel deduction, infinite loop termination, and timeout watchdog.
- `spaas-scheduler-core`: Verifies scoring preferences and constraint filters.
- `spaas-metering`: Verifies credit calculations and idempotency key deduplication.
- `spaas-verification`: Verifies single-node signature checks and multi-node Byzantine quorum consensus.

### 2.2 Integration & Adversarial Tests
- `e2e_workload_lifecycle`: Complete developer submit -> scheduler dispatch -> node execution -> verification -> metering flow.
- `adversarial_security`: Hostile workloads with infinite loops, forged result signatures, tampered workload specifications, and path traversal attempts.
- `node_disappearance_reschedule`: Node crash / disconnect injection with autonomous recovery and rescheduling.
- `scheduler_multi_attribute`: Thermal throttling, battery weighting, and unmetered network gating.

---

## 3. Running Tests
```powershell
.\scripts\test.ps1    # PowerShell
./scripts/test        # Bash
```
