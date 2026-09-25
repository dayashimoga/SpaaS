# SPaaS Security Architecture & Controls

## Zero-Trust Security Model
In SPaaS, neither the developer submitting the workload nor the edge smartphone executing the workload is trusted.

---

## Defensive Countermeasures

| Threat Vector | Potential Impact | Defensive Control |
| :--- | :--- | :--- |
| **Malicious Workload (Infinite Loop)** | CPU & Battery exhaustion | Deterministic WebAssembly fuel (gas) metering; instant termination upon fuel depletion. |
| **Malicious Workload (Memory Bomb)** | Device OOM crash | Hard linear memory ceiling (default 64MB); memory allocation capped at instance start. |
| **Malicious Workload (Host Escape / RCE)**| Sandbox breakout | Pure-Rust WebAssembly interpreter with zero host system calls; strictly sandboxed WASI snapshot 1. |
| **Malicious Node (Forged Results)** | Corrupted computation | Redundant Quorum Consensus (majority voting); cryptographic Ed25519 signature verification. |
| **Replay Attacks** | Duplicate job processing | Short-lived bearer tokens with cryptographically generated unique nonces (UUID v4) and timestamps. |
| **Impersonation** | Unauthorized node actions | Ed25519 public/private key pairs; node enrollment signature verification. |
| **Path Traversal / Injection** | File tampering | Strict input validation via `validate_identifier` and canonical path scrubbing via `sanitize_sandboxed_path`. |
| **Duplicate Billing / Double Spend**| Accounting discrepancies | Metering records enforce a strictly unique `idempotency_key` based on SHA-256(job_id + node_id + result_digest). |
| **Mobile Owner Privacy Leak** | Data harvesting | Zero access to Android contacts, SMS, photos, camera, microphone, or external storage. |

---

## Cryptographic Standards
- **Asymmetric Signatures**: Ed25519 (256-bit Edwards curve DSA)
- **Integrity Digests**: SHA-256 (FIPS 180-4)
- **Token Format**: URL-safe Base64 encoded signed JSON claims with expiration and cryptographic nonces.
