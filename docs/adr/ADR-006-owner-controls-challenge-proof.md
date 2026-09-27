# ADR-006: Locally Enforced Device-Owner Controls & Cryptographic Challenge-Response Verification

**Status:** Accepted  
**Date:** 2026-09-27  
**Deciders:** Principal Android Engineer, DevSecOps Lead, Security Architect  

## Context
A decentralized volunteer compute platform must guarantee that device owners retain absolute sovereignty over their hardware. If a control plane server could override owner limits, or if a rogue workload could deplete battery, overheat a smartphone in a pocket, or incur cellular data charges, trust would be destroyed. Conversely, the control plane must verify that edge nodes actually executed assigned computations rather than returning fabricated results.

## Decision
We enforce **Local Owner Primacy and Cryptographic Execution Proof**:
1. **Absolute Local Owner Authority:**
   - Provider safety policies are enforced entirely on the local device by `ProviderSafetyPolicy.kt` and `ComputeForegroundService.kt`:
     - **Power:** "Run only while charging" toggle, minimum battery cutoff (e.g. stop if battery drops below 30%).
     - **Thermal Ceiling:** Immediate execution abort if battery/CPU temperature exceeds threshold (e.g. 40°C).
     - **Network Limit:** "Run only on unmetered Wi-Fi" vs allowing cellular computation.
     - **Resource Caps:** Maximum CPU core utilization ceiling (e.g. max 50% CPU) and maximum RAM allocation limit.
   - **In-Flight Cancellation Watchdog:** In addition to periodic heartbeat checks, active WASM computation threads check the cancellation token on every instruction gas chunk. If the phone is unplugged or overheats midway through a job, execution aborts immediately.
   - **No Server Override:** The control plane cannot bypass local owner limits under any circumstances.
2. **One-Tap Emergency Stop:**
   - Both the Android app UI and ongoing foreground service notification expose instant `[PAUSE]`, `[DRAIN]`, and `[EMERGENCY STOP]` buttons. Tapping Stop instantly terminates active worker threads and transitions state to `PAUSED`.
3. **Cryptographic Anti-Cheating Challenge Proof:**
   - To verify genuine physical execution and prevent malicious workers from claiming credits for skipped jobs, the control plane periodically issues challenge workloads (`POST /api/v1/workloads/challenge`).
   - The server injects an unpredictable 32-byte cryptographic nonce.
   - The node must execute an authentic WebAssembly SHA-256 / PBKDF2 compute kernel using the nonce as input.
   - The result digest `SHA256(exit_code || stdout || stderr || fuel)` must match the server's expected hash, signed with the node's registered Ed25519 private key.

## Consequences
### Positive:
- Zero battery degradation or thermal damage to physical smartphones.
- Device owners have total peace of mind with verifiable local controls.
- Byzantine malicious workers attempting to forge results are cryptographically caught and rejected.

### Negative / Trade-offs:
- Jobs aborted mid-flight due to owner unplugging must be returned to the queue and rescheduled on another device.
