# Android Compatibility & Lifecycle Policy Matrix

This document defines the strict operating boundaries and API compatibility guidelines for the SPaaS Android Node across modern Android versions (Android 10 through Android 15+).

## Android Version Compatibility Matrix

| Android Version | API Level | Foreground Service Policy | WorkManager Integration | Thermal API | Battery Optimization / OEM Policy |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Android 10 (Q)** | 29 | `FOREGROUND_SERVICE` permission required. Notification mandatory. | Optional backup scheduler. | `PowerManager.addThermalStatusListener` introduced. | Standard Doze & App Standby buckets. |
| **Android 11 (R)** | 30 | Foreground service location/camera restrictions. | Supported. | Full `PowerManager` thermal status monitoring. | Restricts background starts. |
| **Android 12 (S)** | 31 | Strict foreground service launch restrictions from background. | Recommended for non-immediate execution. | Thermal status listener standard. | Phantom process killer introduced (32 max child procs). |
| **Android 13 (T)** | 33 | `POST_NOTIFICATIONS` runtime permission mandatory. | Supported with charging constraints. | Thermal listener supported. | Restricted standby bucket introduced for high background usage. |
| **Android 14 (U)** | 34 | Strict `foregroundServiceType` mandatory. `dataSync` requires justification and has timeout limits. | Strongly recommended for batch tasks. | Thermal listener supported. | Broadcast receiver restrictions. |
| **Android 15 (V)** | 35 | Strict 6-hour timeout for `dataSync`. Recommended: `specialUse` with clear developer rationale or WorkManager. | Preferred execution engine for opportunistic compute. | Enhanced thermal headroom API (`getThermalHeadroom`). | Aggressive OEM background process freezes. |

---

## SPaaS Android Architecture Decisions

### 1. Foreground Service Type Declaration
- **Old Strategy**: Used `foregroundServiceType="dataSync"`.
- **Policy Issue**: On Android 14 and 15, Google Play policy restricts `dataSync` strictly to syncing data between the device and cloud storage, with strict timeout limits (6 hours per 24 hours).
- **Hardened Strategy**:
  - For continuous user-initiated compute while the app is active or charging: Use `foregroundServiceType="specialUse"` with `<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="Voluntary edge compute while charging with explicit owner opt-in" />`.
  - For opportunistic background execution: Use `WorkManager` with `Constraints.Builder().setRequiresCharging(true).setRequiredNetworkType(NetworkType.UNMETERED).setRequiresBatteryNotLow(true)`.

### 2. Battery & Thermal Protection Invariants
- Execution is **immediately paused** when:
  1. `BatteryManager.EXTRA_STATUS` indicates discharging (if "Only while charging" is enabled).
  2. Battery level drops below user-configured safety floor (default: 30%).
  3. `PowerManager.OnThermalStatusChangedListener` reports `THERMAL_STATUS_MODERATE`, `THERMAL_STATUS_SEVERE`, or `THERMAL_STATUS_CRITICAL`.
  4. Network transitions to metered cellular data (if "Only on unmetered Wi-Fi" is enabled).

### 3. OEM Background Restrictions
Many device OEMs (Xiaomi, Samsung, Huawei, OnePlus) aggressively kill background processes even with foreground services active. The SPaaS Android node:
1. Informs the user transparently about battery optimization whitelist settings.
2. Gracefully handles process termination: node status transitions to `Offline` on the control plane via heartbeat timeout, and uncompleted jobs are safely requeued via the lease expiration mechanism.
3. Does not use aggressive restart hacks or unauthorized keep-alive services.

### 4. Privacy & Permission Invariants
The SPaaS node strictly requires only:
- `INTERNET`: For communicating with the Control Plane API and downloading WASM artifacts.
- `ACCESS_NETWORK_STATE`: For detecting Wi-Fi vs metered cellular connectivity.
- `FOREGROUND_SERVICE`: For displaying ongoing compute notifications.
- `POST_NOTIFICATIONS`: For displaying the mandatory user status notification on Android 13+.

Zero access is requested or permitted for:
- Contacts, SMS, Photos, Videos, Documents, Storage, Location, Camera, Microphone, Phone State, or Sensor data.
