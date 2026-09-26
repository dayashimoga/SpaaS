# SPaaS Mobile Provider Guide

## 1. Volunteering Idle Smartphone Compute

The SPaaS Universal Edge Compute Fabric allows smartphone owners to securely monetize or volunteer spare computing cycles from their modern mobile devices. By running workloads while your phone is plugged in overnight or docked on your desk connected to Wi-Fi, you contribute to distributed scientific computing, cryptography, and parallel edge analytics while earning verifiable compute credits.

---

## 2. Privacy & Sandbox Security Guarantees

As a compute provider, your privacy and device integrity are protected by strict hardware and operating system isolation:

- **Zero Dangerous Permissions**: The SPaaS Android application requires **zero** sensitive Android permissions. It does not request access to contacts, photos, SMS, camera, microphone, location, or device storage.
- **Process & Memory Isolation**: Workloads run inside a sandboxed WebAssembly engine (`wasmi`) executing within a dedicated Android service process. The workload has zero access to Android internal APIs, IPC channels, or system files.
- **Immediate Physical Preemption**: The device owner retains absolute control. A persistent, prominent foreground notification provides instant **PAUSE** and **DISCONNECT** buttons that abort any running job within 50 milliseconds.

---

## 3. Automatic Owner Safeguards & Thermal Protection

SPaaS is built to guarantee that volunteering compute never compromises device battery longevity or day-to-day usability:

| Safeguard Feature | Default Setting | Operational Behavior |
|---|---|---|
| **Only While Charging** | `Enabled` | Compute immediately pauses when the charging cable or wireless pad is disconnected. |
| **Only on Unmetered Wi-Fi** | `Enabled` | Workload downloads and execution suspend instantly if the phone switches to cellular data (LTE/5G). |
| **Battery Floor Cutoff** | `30%` (Configurable 20%-80%) | If device is discharging and battery drops below threshold, the agent enters sleep mode. |
| **Thermal Ceilings** | `MODERATE (40°C)` | If battery or SoC temperature exceeds threshold, active jobs are cleanly yielded to avoid thermal stress. |
| **Screen-On Yielding** | `Optional` | Can be configured to pause compute whenever the phone screen is turned on by the user. |

---

## 4. Pairing Your Smartphone with a Cluster

### Method 1: QR Code Fast Pairing
1. Open the SPaaS Web Management Console in your desktop browser.
2. Click **+ Add Compute Device** in the top navigation bar.
3. Select the **Android Smartphone** tab to generate an ephemeral pairing QR code.
4. Launch the SPaaS Node app on your smartphone, tap **Scan Pairing QR**, and point the camera at your desktop monitor.
5. The device automatically exchanges Ed25519 public keys and enters the active worker pool.

### Method 2: 6-Character Manual Pairing Code
If your camera is unavailable or you are pairing an Android emulator:
1. Note the 6-character uppercase alphanumeric code shown on the desktop console (e.g. `K9X2P4`).
2. Enter this code into the SPaaS Android app input field along with the control plane IP.
3. Tap **Connect** to finalize enrollment.

---

## 5. Understanding Your Credit Earnings

Every completed workload settled on the SPaaS network is compensated in TEST CREDITS based on deterministic resource accounting:
- **Base Execution Reward**: 10 TEST CREDITS per settled job.
- **Fuel Gas Compensation**: Calculated per 100,000 WebAssembly instructions executed.
- **Hardware Qualification Multiplier**: Higher-tier devices with higher MIPS and low thermal throttling receive bonus multipliers.
- **Provider Payout Ratio**: Providers receive 90% of the total workload settlement, credited directly to their device public key.
