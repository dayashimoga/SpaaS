# SPaaS User & Developer Guide

## 1. Developer Workflow Overview

The SPaaS Universal Edge Compute Fabric enables developers and data engineers to dispatch compute tasks across an edge mesh of smartphones and workstations. Workloads are written in any language compiling to WebAssembly (Rust, C/C++, Go, AssemblyScript), sandboxed in deterministic WASI environments, and settled cryptographically.

You can interact with SPaaS via the official `spaas` CLI or the Web Management Console.

---

## 2. Developer Command Line Interface (`spaas`)

The `spaas` CLI provides complete control over workload submission, cluster inspection, and cryptographic verification:

### 2.1 Cryptographic Identity Generation
Generate an Ed25519 signing keypair for authenticating workload submissions:
```bash
spaas keygen --out-key ./dev_key.pem --out-pub ./dev_pub.pem
```

### 2.2 Inspecting Edge Fleet Status
View all registered physical, emulator, desktop, and simulated edge nodes:
```bash
spaas node list --status healthy
```
Output includes node ID, architecture, device model, battery percentage, thermal state, and MIPS throughput.

### 2.3 Submitting a Workload
Submit a compiled WebAssembly binary with execution limits and requirements:
```bash
spaas workload submit ./target/wasm32-wasip1/release/prime_sieve.wasm \
  --name "prime-sieve-bench" \
  --max-fuel 10000000 \
  --max-memory 16 \
  --timeout-ms 20000 \
  --require-charging \
  --require-unmetered \
  --key ./dev_key.pem
```

### 2.4 Monitoring Job Lifecycle & Sandboxed Logs
Query real-time job execution state, exit codes, and sandboxed standard output:
```bash
# View list of active and completed jobs
spaas job list

# Inspect detailed status of a specific job
spaas job get <JOB_ID>

# Fetch sandboxed STDOUT / STDERR logs
spaas job logs <JOB_ID>

# Cancel a queued or running job
spaas job cancel <JOB_ID>
```

---

## 3. Web Management Console User Experience

The SPaaS Web Console provides a responsive dashboard for monitoring and managing your cluster:

### 3.1 Cluster Overview Tab
- **Real-Time Fleet KPI Cards**: Displays active vs idle nodes, queued jobs, completed workloads, and cluster uptime.
- **Fleet Breakdown Pills**: Instant visibility into the ratio of Physical Phones, Emulators, Desktops, and Simulated Workers.

### 3.2 Devices Tab
- **Fleet Filter Tabs**: Filter devices by hardware category (Physical, Desktop, Emulator, Simulated).
- **Device Detail Drawer**: Inspect live hardware metrics (MIPS qualification, thermal level, battery %, network latency, active lease).
- **Remote Operations**: Trigger device capability re-qualification or administrative drain.

### 3.3 Workload Manifest Studio Tab
- **Starter Catalog Presets**: One-click dispatch of pre-verified WebAssembly modules (`hello-world-wasi`, `sha256-hasher`, `prime-sieve-compute`, `edge-matrix-multiplication`).
- **Interactive Form & YAML Modes**: Configure memory limits, fuel ceilings, and hardware constraints with bi-directional YAML synchronization.

### 3.4 Jobs & Execution History Tab
- **10-Step Deterministic Timeline**: Visual progression from Submission to Settlement.
- **Job Detail Modal**: Inspect exit code, exact fuel consumed, wall-clock time, estimated energy (mWh/Joules), and verification receipts.
- **Scheduler Explainability**: Click "Why this device?" to view the candidate evaluation rankings and filter rejection reasons.

### 3.5 Usage & Credits Tab
- **Dual-Entry Ledger**: Real-time audit of all TEST CREDITS earned by providers and spent by submitters.
- **Consumer Account Balance**: Check your submitter balance, total spend, and job history.
