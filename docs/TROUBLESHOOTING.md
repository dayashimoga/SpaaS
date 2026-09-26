# SPaaS Operational Troubleshooting Playbook

## 1. Diagnostic Decision Tree

When encountering issues in a running SPaaS cluster, follow this triage flow:

```
[ Problem Detected ]
         │
         ├─► Node Connectivity / Disappearance? ──► Section 2: Fleet Connectivity
         ├─► Job Rejected / Scheduling Timeout? ──► Section 3: Scheduling & Ingress
         ├─► Workload Execution Trap / OutOfGas? ──► Section 4: WASM Runtime Traps
         ├─► Cryptographic / Signature Failure? ──► Section 5: Security & Verification
         └─► Android Mobile Node Terminated?   ──► Section 6: Android Environment
```

---

## 2. Fleet Connectivity & Node State Issues

### 2.1 Symptom: Node Transitions to `OFFLINE` Unexpectedly
- **Root Cause**: Node missed periodic heartbeats beyond the configured `heartbeat_timeout_ms` (default 10s).
- **Diagnostics**:
  1. Inspect control plane logs: `grep "missed heartbeat" /var/log/spaas.log`.
  2. Check device IP reachability: `ping <node_ip>`.
- **Resolution**:
  - Verify local Wi-Fi connectivity on the edge device.
  - If the node is on mobile data, ensure `require_unmetered_network` is not blocking heartbeats.
  - In Android, verify that battery optimization exemption is granted to allow background network polling.

### 2.2 Symptom: Pairing Code Rejection / "Invalid Pairing Code"
- **Root Cause**: 6-character ephemeral pairing codes expire after 10 minutes.
- **Resolution**: Click **Refresh Code** in the web management console to generate a new short code and challenge nonce.

---

## 3. Workload Ingress & Scheduling Issues

### 3.1 Symptom: "No Eligible Nodes Found" (HTTP 503)
- **Root Cause**: Candidate nodes fail one or more hard filter constraints in `EdgeScheduler`.
- **Diagnostics**:
  - Check the scheduler decision endpoint: `GET /api/v1/jobs/:id/scheduler-decision`.
  - Common rejection reasons:
    - `ChargingRequired`: Device is unplugged while workload specifies `require_charging: true`.
    - `InsufficientBattery`: Battery level is below node policy cutoff (e.g. 25% < 30%).
    - `ThermalThrottled`: Smartphone battery temperature exceeds `MODERATE` threshold.
    - `RegionMismatch`: Workload specifies preferred regions that match no active nodes.
- **Resolution**: Adjust `WorkloadSpec` limits or connect mobile devices to chargers to expand candidate eligibility.

---

## 4. WebAssembly Runtime Traps & Failures

### 4.1 Symptom: `OutOfGas` / "WebAssembly Fuel Exhaustion"
- **Root Cause**: Guest code exceeded the allocated `limits.max_fuel` instruction budget before returning.
- **Resolution**:
  - Check for unintended unbounded loops or non-terminating recursion in guest bytecode.
  - If the workload is legitimately compute-heavy, raise `max_fuel` (e.g. from 1,000,000 to 25,000,000 fuel units).

### 4.2 Symptom: `MemoryOutOfBounds` / Sandbox Memory Exhaustion
- **Root Cause**: Workload attempted to allocate linear memory beyond `limits.max_memory_bytes`.
- **Resolution**: Increase `max_memory_bytes` in workload specification (e.g. 8MB to 32MB).

---

## 5. Cryptographic & Verification Failures

### 5.1 Symptom: "Ed25519 Signature Verification Failed"
- **Root Cause**: Mismatch between the signed canonical byte payload and the received payload.
- **Resolution**:
  - Ensure serializers output canonical RFC 8259 JSON without non-deterministic key ordering.
  - Verify the submitter's public key matches the key used during signature creation.

---

## 6. Android Mobile Environment Issues

### 6.1 Symptom: Foreground Service Killed by Operating System
- **Root Cause**: Aggressive OEM battery killers (e.g. Samsung Device Care, Xiaomi MIUI battery savers).
- **Resolution**:
  1. Open Android **Settings** $\to$ **Apps** $\to$ **SPaaS Node**.
  2. Select **Battery** $\to$ Change from "Optimized" to **"Unrestricted"**.
  3. Ensure the persistent foreground notification remains pinned in the status bar.

### 6.2 Symptom: Emulator Cannot Connect to Localhost (`127.0.0.1`)
- **Root Cause**: Inside the Android Emulator virtual network, `127.0.0.1` refers to the emulator's own virtual loopback, not the development host.
- **Resolution**: Use host alias IP `10.0.2.2:8080` or your workstation's LAN IP address (e.g. `192.168.1.50:8080`).
