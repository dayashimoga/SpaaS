# SPaaS iOS Compute Node — Architectural & Platform Limitations

**Document Version:** 1.0.0  
**Target Environment:** Apple iOS 16.0+ / iPadOS 16.0+  
**Classification:** Transparent Systems Engineering Disclosure

---

## Executive Summary

Unlike desktop platforms (Windows, Linux, macOS) or voluntary Android nodes running foreground background services, Apple iOS enforces strict process lifecycle and sandbox limitations to protect user battery life and responsiveness. 

This document details the genuine platform boundaries of running SPaaS edge compute workloads on iOS devices. SPaaS adheres strictly to honest engineering principles: **we never simulate or misrepresent iOS worker capabilities**.

---

## 1. Background Execution Restrictions

| Execution State | Maximum Runtime | Trigger Mechanism | SPaaS Capability |
|---|---|---|---|
| **Active Foreground** | Unlimited (screen on) | User active | Full WASM compute (Tier 1-3) |
| **Foreground Keep-Awake** | Continuous while plugged into AC | `isIdleTimerDisabled = true` | Dedicated night-time charging compute |
| **Background App Refresh** | ~30 seconds per window | OS-scheduled `BGAppRefreshTask` | Heartbeat & lightweight microbenchmarks only |
| **Background Processing Task** | ~2-5 minutes per window | OS-scheduled `BGProcessingTask` (requires AC power & screen locked) | Short-duration WASM workloads (<5M fuel) |
| **Suspended / Terminated** | 0 seconds | Memory pressure or app switcher swipe | Node marked Offline in fabric |

### Critical Constraints
1. **Unpredictable Scheduling:** Apple's CoreOS scheduling heuristic (`dasd` / `duetexpertd`) determines when background tasks run based on user habit, battery percentage, and thermal state. SPaaS cannot guarantee a fixed polling interval while backgrounded.
2. **Immediate Task Expiration:** When iOS revokes background runtime, the app receives `task.expirationHandler` and has <5 seconds to save state and yield before SIGKILL (0x8badf00d).
3. **Low Power Mode:** When the user enables iOS Low Power Mode, all background refresh tasks are completely suspended.

---

## 2. WebAssembly Execution & Sandboxing

1. **JIT Prohibitions:**
   - Apple App Store policy strictly forbids arbitrary writable and executable memory (`W^X` violation / missing `com.apple.developer.kernel.extended-virtual-addressing` on non-jailbroken devices).
   - Dynamic JIT compilation (like standard V8 or Wasmtime JIT) cannot run in App Store distributed iOS applications.
2. **Approved Execution Engine:**
   - **JavaScriptCore (`JSContext`):** Apple's native JavaScriptCore framework provides built-in `WebAssembly` support that is compliant with App Store guidelines and hardware-accelerated where allowed by the OS.
   - **Bytecode Interpretation (`WasmKit`):** A pure Swift interpreter can execute arbitrary WASM bytecode with deterministic instruction counting (fuel) without requiring JIT entitlements.

---

## 3. Cryptographic Identity & Hardware Root of Trust

- SPaaS iOS identity keys are generated and stored inside the **Apple Secure Enclave** using `CryptoKit.SecureEnclave.P256.Signing` or stored in the hardware-backed iOS Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.
- Private keys can never be exported or exfiltrated from the physical Secure Enclave.
- Job results are signed using the hardware key and verifiable by the Cloudflare Control Plane.

---

## 4. Recommended Operational Profile

For voluntary participants contributing compute via iPhone or iPad:
1. **Primary Mode (Recommended):** Place device on charger at night with **Compute While Charging** enabled (screen auto-dims, `isIdleTimerDisabled = true`). The device operates as a continuous voluntary edge worker.
2. **Secondary Mode (Opportunistic):** `BGProcessingTaskRequest` scheduled for execution when the device is locked and connected to power.
