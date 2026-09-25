# SPaaS User Guide (Developers & Operators)

## 1. Developer Workflow Overview
As a developer, you submit sandboxed WebAssembly workloads to the SPaaS fabric using the `spaas` CLI or Web Management Console.

---

## 2. Using the `spaas` CLI

### 2.1 Generating Developer Identity
```bash
spaas keygen
```

### 2.2 Inspecting Active Fleet
```bash
spaas node list
```

### 2.3 Validating a WebAssembly Workload
```bash
spaas workload validate path/to/workload.wasm
```

### 2.4 Submitting a Workload
```bash
spaas workload submit path/to/workload.wasm \
  --name "matrix_computation" \
  --max-fuel 5000000 \
  --timeout-ms 15000
```

### 2.5 Monitoring Jobs & Logs
```bash
spaas job list
spaas job get <job_id>
spaas job logs <job_id>
```

### 2.6 Checking System Telemetry
```bash
spaas system health
```
