# SPaaS Comprehensive Threat Model

## 1. STRIDE Threat Analysis

### 1.1 Spoofing
- **Threat**: An attacker impersonates a registered worker node to claim jobs and receive compute credits.
- **Defense**: All worker nodes authenticate using Ed25519 keypairs during registration. Heartbeats and results are signed with the node's private key. Control plane verifies the signature against the registered public key.

### 1.2 Tampering
- **Threat**: An intermediary or compromised edge node tampers with the workload bytecode or the output returned to the developer.
- **Defense**: Workload specifications contain the SHA-256 digest of the WASM bytecode, signed by the developer. Execution output is hashed (`result_digest`) and signed by the node. Redundant quorum verification checks consensus across independent nodes.

### 1.3 Repudiation
- **Threat**: A node denies executing a job, or a developer denies submitting a job.
- **Defense**: Cryptographic nonces, Ed25519 digital signatures, and permanent append-only audit ledgers provide non-repudiation.

### 1.4 Information Disclosure
- **Threat**: A rogue workload reads private user data from the host Android phone.
- **Defense**: The WASM runtime exposes NO host filesystem paths, NO device sensor APIs, NO contacts, and NO camera/microphone access. WASI `fd_read` returns EOF for stdin, and filesystem syscalls return `ENOSYS`.

### 1.5 Denial of Service
- **Threat**: An adversary submits jobs with infinite loops or consumes all phone battery and causes thermal runaway.
- **Defense**: Strict fuel (gas) limits are deducted on every WebAssembly instruction. The autonomous `ResourceSafetyMonitor` immediately yields compute if thermal status exceeds `LIGHT`/`MODERATE` or battery drops below safety thresholds.

### 1.6 Elevation of Privilege
- **Threat**: A workload exploits kernel or runtime vulnerabilities to gain root or host execution privileges.
- **Defense**: WebAssembly runtime runs inside the unprivileged Android application sandbox with zero elevated Linux capabilities (`no_new_privs`).
