# ADR-004: Zero-Friction Dual-Endpoint Remote Device Onboarding & Persistent Keystore Identity

**Status:** Accepted  
**Date:** 2026-09-27  
**Deciders:** Principal Android Engineer, Distributed Systems Architect, Product UX Designer  

## Context
Initial edge node onboarding relied on local Wi-Fi LAN IPs (`192.168.0.111:8080`) or emulator aliases (`10.0.2.2:8080`). This failed completely when smartphones connected over mobile cellular networks (4G/5G), carrier NAT (CGNAT), or guest Wi-Fi networks with AP isolation enabled. Furthermore, Kotlin clients stored cryptographic keypairs in ephemeral memory or standard unencrypted preferences, causing device identity loss when the Android OS killed the process.

## Decision
We implement a **Zero-Friction Dual-Endpoint Remote Onboarding Architecture**:
1. **Zero LAN Dependencies:** All production communication occurs exclusively over authenticated public HTTPS and WebSocket connections with valid TLS certificates.
2. **1-Tap Deep Link & Dynamic QR Code:**
   - Web Console generates an expiring 6-character token (`SP-XXXX`, 300s TTL).
   - Generates an SVG QR code and deep link with the custom URI scheme:
     `spaas://pair?code=SP-XXXX&primary=https%3A%2F%2Fapi.spaas.dev&backup=https%3A%2F%2Fspaas-dr.a.run.app`
   - Android application registers an `intent-filter` in `AndroidManifest.xml` for `scheme="spaas" host="pair"`. Tapping the link or scanning the QR code instantly launches the app and populates the pairing token and dual endpoints.
3. **Android Keystore Persistent Identity:**
   - `EncryptedDeviceIdentityStore.kt` generates an Ed25519 / EC-256 keypair backed by Android Keystore hardware security (TEE / StrongBox where available).
   - Node UUID, public key, and server endpoints are durably persisted in `EncryptedSharedPreferences`.
   - Node identity survives application force-stop (`am force-stop`), system reboot, and memory pressure recreation.
4. **Adaptive Outbound WebSocket Transport:**
   - Worker connects outbound to `wss://api.spaas.dev/api/v1/ws`. Outbound connections naturally traverse NAT, CGNAT, firewalls, and proxy barriers without router port forwarding.
   - Implements exponential backoff reconnect (1s, 2s, 4s, ... max 30s) and automatic endpoint failover to the backup URL if the primary fails 3 consecutive health checks.

## Consequences
### Positive:
- True zero-friction onboarding: Open website -> Add Device -> Scan QR -> Approved.
- Smartphones function seamlessly across cellular networks, home Wi-Fi, and public networks.
- Permanent node identity eliminates re-pairing churn.
- Private keys never leak to external application storage.

### Negative / Trade-offs:
- Requires Android API 26+ (Android 8.0) for modern Keystore APIs (project targets SDK 34, minimum SDK 29, so fully compatible).
