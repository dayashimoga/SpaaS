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

The SPaaS Web Console provides a role-customized, responsive interface tailored for Customers, Providers, Developers, and Administrators.

### 3.1 Task-First Customer Workspace (Customer Role)
When logged in as a Customer or Developer, the console presents a task-centric workspace designed to submit and monitor workloads without cluttering the screen with infrastructure-heavy node internals:

- **Workspace Header**: Displays `SPaaS Compute | Customer Workspace` with the active enterprise tenant chip (e.g. `Acme Labs`).
- **"Run your next workload" Card**:
  - Subtitle: *"Submit compute tasks and let SPaaS choose the most suitable execution environment."*
  - **Strategy Selector**: Toggle between four optimization objectives:
    - `Fastest`: Prioritizes lowest latency and fastest available CPU/device.
    - `Lowest cost`: Prioritizes lowest credit rate across edge devices.
    - `Balanced`: Balances wall-clock execution time against credit spend.
    - `Private`: Restricts execution strictly to dedicated enterprise/tenant nodes.
  - **Dynamic Compute Availability Banner**:
    - When zero compatible devices are online: Displays actionable alert: `(!) No eligible edge devices. Local execution may still be available if supported.`
    - When devices are online: Displays live count of eligible physical and desktop nodes.
  - **Primary Action**: `Design workload flow ->` navigates directly into the Workload Manifest Studio.
- **Customer KPI Metrics**:
  - `Running`: Live count of active jobs executing on the edge mesh.
  - `Completed`: Total count of settled jobs.
  - `CR Usage`: Real-time consumption of non-fiat TEST CREDITS.
- **Recent Executions**:
  - Clean empty state: *"No executions yet / Your submitted workloads and results will appear here."*
  - Live table rendering active and settled jobs with status indicators, duration, and download links.

### 3.2 Operator Infrastructure View (Admin / Ops Roles)
Platform operators and infrastructure engineers have access to the comprehensive fleet control plane:
- **Fleet KPI Cards**: Active vs idle nodes, queued jobs, and operational uptime (`Operational (99.99% SLA)`).
- **Dynamic Verification Rate**: Honestly calculates and renders verification status:
  - If 0 jobs completed: Displays `N/A (0/0 verified)`.
  - When jobs are completed: Displays exact ratio, e.g. `100.0% (12/12 verified)`.
- **Fleet Breakdown Pills**: Instant visibility into the ratio of Physical Phones, Emulators, Desktops, and Simulated Workers.

### 3.3 Workload Manifest Studio Tab
- **Starter Catalog Presets**: One-click dispatch of pre-verified WebAssembly modules (`hello-world-wasi`, `sha256-hasher`, `prime-sieve-compute`, `edge-matrix-multiplication`).
- **Interactive Form & YAML Modes**: Configure memory limits, fuel ceilings, and hardware constraints with bi-directional YAML synchronization.

### 3.4 Jobs & Execution History Tab
- **10-Step Deterministic Timeline**: Visual progression from Submission to Settlement.
- **Job Detail Modal**: Inspect exit code, exact fuel consumed, wall-clock time, estimated energy (mWh/Joules), and verification receipts.
- **Scheduler Explainability**: Click "Why this device?" to view candidate evaluation rankings and filter rejection reasons.

### 3.5 Usage & Credits Tab
- **Balanced Dual-Entry Ledger**: Real-time audit of all TEST CREDITS earned by providers and spent by submitters with verified $\Delta = 0.0000\text{ CR}$ balance identity.
- **Consumer Account Balance**: Check your submitter balance, total spend, and job history.

