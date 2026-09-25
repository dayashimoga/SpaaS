# SPaaS REST & RPC API Reference

Base URL: `http://localhost:8080` (or `http://localhost:8000` via Gateway)

---

## 1. Node Management

### `POST /api/v1/nodes/register`
Enrolls an edge node into the compute fabric.
- **Request**:
  ```json
  {
    "public_key": "64_hex_chars",
    "device_type": "android_smartphone",
    "capabilities": {
      "architecture": "aarch64",
      "cpu_cores": 8,
      "total_ram_mb": 8192,
      "total_storage_mb": 128000,
      "device_model": "Pixel 8 Pro",
      "os_name": "Android",
      "os_version": "15",
      "has_npu": true,
      "has_gpu_vulkan": true,
      "agent_version": "0.1.0",
      "supported_runtimes": ["wasm_wasi"]
    },
    "initial_telemetry": { ... },
    "initial_policy": { ... },
    "region": "us-east",
    "is_simulated": false,
    "enrollment_signature": "base64_sig",
    "timestamp_ms": 1727260800000
  }
  ```
- **Response**: `200 OK`
  ```json
  {
    "node_id": "uuid-v4",
    "auth_token": "base64_bearer_token",
    "control_plane_pubkey": "64_hex_chars",
    "heartbeat_interval_secs": 15
  }
  ```

### `POST /api/v1/nodes/heartbeat`
Submits real-time node telemetry and checks for remote commands.

### `GET /api/v1/nodes/:node_id/poll`
Pulls any dispatched workload assigned to this worker node.

### `POST /api/v1/nodes/results`
Submits cryptographically signed execution output.

---

## 2. Workload & Job Management

### `POST /api/v1/jobs`
Submits a versioned, cryptographically signed WorkloadSpec.

### `GET /api/v1/jobs`
Lists all submitted workloads and execution states.

### `GET /api/v1/jobs/:job_id`
Retrieves detailed state, assigned worker node, and execution results for a job.

### `POST /api/v1/jobs/:job_id/cancel`
Cancels a queued or scheduled workload.

---

## 3. Observability & Accounting

### `GET /api/v1/system/health`
Returns aggregate health, queue depth, active/idle/offline nodes, and uptime.

### `GET /api/v1/metering`
Returns verifiable dual-entry credit ledger records with idempotency keys.

### `GET /api/v1/audit`
Returns immutable security audit trail.

### `GET /metrics`
Exposes Prometheus-compatible metric counters and gauges.
