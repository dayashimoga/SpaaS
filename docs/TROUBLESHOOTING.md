# SPaaS Operational Troubleshooting Guide

## 1. Node Enrollment & Connectivity Issues

### 1.1 Node Marked OFFLINE
- **Cause**: Node agent failed to deliver heartbeats within `node_offline_timeout_secs` (default 20 seconds).
- **Resolution**: Check device network connectivity. If the node went into battery sleep or cellular data mode, review provider safety policies.

### 1.2 "No Eligible Node Found" on Workload Submission
- **Cause**: No enrolled nodes currently satisfy the hard eligibility constraints (e.g. required architecture `aarch64`, minimum RAM, or unmetered network).
- **Resolution**: Relax workload requirements in `WorkloadSpec` or enroll additional simulated/physical nodes via `./scripts/dev-up`.

---

## 2. Workload Runtime Traps

### 2.1 "WebAssembly fuel exhaustion"
- **Cause**: Workload exceeded `limits.max_fuel` (default 10,000,000 fuel units).
- **Resolution**: Increase `max_fuel` parameter upon submission or optimize WebAssembly loop logic.

### 2.2 "Execution timed out"
- **Cause**: Workload took longer than `limits.timeout_ms` (default 30,000 ms).
- **Resolution**: Increase `timeout_ms` or decompose heavy jobs into smaller parallel map-reduce batches.

---

## 3. Cryptographic Verification Failures

### 3.1 "Signature verification failed"
- **Cause**: The workload specification or result digest was altered after signing, or signed with an unmatching private key.
- **Resolution**: Ensure the submitting client signs the exact canonical representation via `sign_workload`.
