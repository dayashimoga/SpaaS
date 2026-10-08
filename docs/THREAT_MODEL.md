# SPaaS Comprehensive Threat Model & Adversarial Defense Specification

## 1. STRIDE Threat Analysis

### 1.1 Spoofing
- **Threat**: An attacker impersonates a registered worker node to claim jobs and receive compute credits.
- **Defense**: All worker nodes authenticate using Ed25519 keypairs during registration. Heartbeats and results are signed with the node's private key. Control plane verifies the signature against the registered public key in DO SQLite. WebSocket upgrades require a valid `device_token`.

### 1.2 Tampering
- **Threat**: An intermediary or compromised edge node tampers with the workload bytecode or the output returned to the developer.
- **Defense**: Workload specifications contain the SHA-256 digest of the WASM bytecode, signed by the developer. Execution output is hashed (`result_digest`) and signed by the node. Redundant quorum verification checks consensus across independent nodes.

### 1.3 Repudiation
- **Threat**: A node denies executing a job, or a developer denies submitting a job.
- **Defense**: Cryptographic nonces, Ed25519 digital signatures, and permanent append-only audit ledgers provide non-repudiation.

### 1.4 Information Disclosure
- **Threat**: A rogue workload reads private user data from the host Android phone or accesses other tenants' artifacts.
- **Defense**: The WASM runtime exposes NO host filesystem paths, NO device sensor APIs, NO contacts, and NO camera/microphone access. WASI `fd_read` returns EOF for stdin, and filesystem syscalls return `ENOSYS`. Cloudflare R2 artifacts are partitioned strictly by `/artifacts/:tenantId/:sha256`.

### 1.5 Denial of Service
- **Threat**: An adversary submits jobs with infinite loops, floods the coordinator with heartbeats, or attempts bot registration.
- **Defense**: Strict fuel (gas) limits are deducted on every WebAssembly instruction. The autonomous `ResourceSafetyMonitor` immediately yields compute if thermal status exceeds `MODERATE` or battery drops below safety thresholds. Public registration endpoints require Cloudflare Turnstile verification. Quota Guard enforces heartbeat backpressure.

### 1.6 Elevation of Privilege
- **Threat**: A workload exploits kernel or runtime vulnerabilities to gain root privileges, or an authenticated user with `SECURITY` or `CUSTOMER` role executes administrative or destructive actions.
- **Defense**: WebAssembly runtime runs inside the unprivileged Android application sandbox with `no_new_privs`. In the control plane, a central deny-by-default route interceptor validates role permissions; specifically, `SECURITY` role is strictly forbidden from node deletion, workload submission, and ledger modification.

---

## 2. Adversarial Test Matrix (32 Automated Regression Vectors)

The SPaaS control plane is continuously verified against 32 distinct attack vectors in `tests/e2e-regression.test.js`:

| Attack Vector | Category | Adversarial Payload / Action | Expected Result | Automated Test |
|---|---|---|---|---|
| **Attack 01** | RBAC / Auth | Unauthenticated request to `/api/v1/jobs` | `401 Unauthorized` | Subtest 1 |
| **Attack 02** | RBAC / Privilege | Customer attempts `DELETE /api/v1/nodes/:id` | `403 Forbidden` | Subtest 2 |
| **Attack 03** | Auth Bypass | Malformed JWT / Bearer token | `401 Unauthorized` | Subtest 3 |
| **Attack 04** | Session Replay | Expired session token | `401 Unauthorized` | Subtest 4 |
| **Attack 05** | IDOR / Tenant Leak | Customer queries another tenant's job `/api/v1/jobs/:otherId` | `403 Forbidden` | Subtest 5 |
| **Attack 06** | Path Traversal | `/artifacts/../../etc/passwd` injection | `400 / 403 Sanitized` | Subtest 6 |
| **Attack 07** | Payload Injection | Malformed JSON / oversized payload | `400 Bad Request` | Subtest 7 |
| **Attack 08** | Auth Leak | Unauthenticated call to `/api/v1/auth/me` | `401 Unauthorized` | Subtest 8 |
| **Attack 09** | Role Escalation | Modifying role claim in bearer header | `403 Forbidden` | Subtest 9 |
| **Attack 10** | Tenant Metering Leak | Customer queries global `/api/v1/metering` | Returns only tenant records | Subtest 10 |
| **Attack 11** | QR Replay | Replaying used pairing token for node enrollment | `409 Conflict: Already used` | Subtest 11 |
| **Attack 12** | QR Expiry | Presenting expired pairing token (>15 min) | `401 / 403 Expired` | Subtest 12 |
| **Attack 13** | Idempotency Clash | Cross-tenant collision on identical idempotency key | Separated by `tenant_id` | Subtest 13 |
| **Attack 14** | Fencing Token Replay | Worker submits result with stale fencing sequence | `409 Stale Fencing Token` | Subtest 14 |
| **Attack 15** | Strict Auth Interceptor | Missing cookie + missing authorization header | `401 Unauthorized` | Subtest 15 |
| **Attack 16** | Trace / Decision IDOR | Customer reads `/jobs/:id/trace` of another tenant | `403 Forbidden` | Subtest 16 |
| **Attack 17** | DR Incomplete State | Standby hydration omitting users or leases | Checkpoint exports 8 tables | Subtest 17 |
| **Attack 18** | Ledger Discrepancy | Tampering with credit/debit calculation | $\Delta > 0$ flags `DISCREPANCY` | Subtest 18 |
| **Attack 19** | Bootstrap Brute-Force | Guessing one-time `spaas_boot_...` token | 403 + Rate Limit | Subtest 19 |
| **Attack 20** | Post-Bootstrap Hijack | Calling `/api/v1/auth/bootstrap` post-initialization | `409 Already Bootstrapped` | Subtest 20 |
| **Attack 21** | Password Policy | Registering with weak password (<8 chars, no symbol) | `400 Weak Password` | Subtest 21 |
| **Attack 22** | Account Lockout | 5 consecutive failed logins | `403 Account Locked` | Subtest 22 |
| **Attack 23** | Passkey Replay | Replaying WebAuthn challenge response | `401 Invalid Authenticator` | Subtest 23 |
| **Attack 24** | Session Revocation | Presenting token after explicit `/api/v1/auth/logout` | `401 Session Revoked` | Subtest 24 |
| **Attack 25** | Admin Unlock Bypass | Non-admin attempting to unlock user account | `403 Forbidden` | Subtest 25 |
| **Attack 26** | MFA Spoofing | Submitting invalid TOTP code | `401 Invalid MFA Token` | Subtest 26 |
| **Attack 27** | Password Reset Tamper | Submitting expired password reset token | `401 Token Expired` | Subtest 27 |
| **Attack 28** | Session Enumeration | Customer attempting to list active platform sessions | `403 Forbidden` | Subtest 28 |
| **Attack 29** | Turnstile Bot Bypass | Submitting public signup without Turnstile token | `403 Bot Verification Failed`| Subtest 29 |
| **Attack 30** | R2 Artifact IDOR | Cross-tenant download from `/artifacts/:otherTenant/` | `403 Forbidden` | Subtest 30 |
| **Attack 31** | Queue Poison Message | Injecting non-JSON byte frame into delivery queue | Moved to dead-letter queue | Subtest 31 |
| **Attack 32** | CI Sandbox Escape | CI job requesting elevated capabilities | Enforces CPU/RAM limits | Subtest 32 |
| **Attack 64** | Security Role Escalate | `SECURITY` role attempts `DELETE /api/v1/nodes/:id` | `403 Forbidden` | Subtest 64 |
