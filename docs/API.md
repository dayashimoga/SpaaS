# SPaaS REST & RPC API Reference

**Base URL (Production):** `https://spaas-control-plane.dayashimoga.workers.dev`  
**Base URL (Local Standalone):** `http://localhost:8080`

---

## 1. Node Management & Device Pipeline

### `POST /api/v1/devices/pair`
Enrolls an edge node into the compute fabric using a single-use pairing token or QR short code.
- **Headers:** `Content-Type: application/json`
- **Request:**
  ```json
  {
    "pairing_token": "spaas_pair_...",
    "node_id": "9c1820f9-0c70-498c-94a8-544e4c54e425",
    "device_name": "Vivo I2221",
    "device_type": "android_smartphone",
    "capabilities": {
      "architecture": "aarch64",
      "cpu_cores": 8,
      "total_ram_mb": 8192,
      "device_model": "I2221",
      "supported_runtimes": ["wasm_wasi"]
    }
  }
  ```
- **Response:** `200 OK`
  ```json
  {
    "status": "approved",
    "node_id": "9c1820f9-0c70-498c-94a8-544e4c54e425",
    "auth_token": "spaas_auth_...",
    "epoch": 1,
    "heartbeat_interval_ms": 2000
  }
  ```

### `POST /api/v1/nodes/heartbeat`
Submits real-time node telemetry every ~2s. Returns assigned job and active safety policy if busy.
- **Headers:** `Authorization: Bearer <auth_token>`, `Content-Type: application/json`
- **Request:**
  ```json
  {
    "node_id": "9c1820f9-0c70-498c-94a8-544e4c54e425",
    "state": "Ready",
    "battery_pct": 74,
    "is_charging": false,
    "thermal_status": "NONE"
  }
  ```
- **Response:** `200 OK`
  ```json
  {
    "status": "ok",
    "timestamp": 1759114000000,
    "assigned_job": {
      "job_id": "challenge_abcdef12",
      "workload_id": "challenge_sha256_abcdef",
      "lease_id": "lease_...",
      "fencing_token": "ft_...",
      "spec": { ... },
      "wasm_bytes": "<base64>"
    },
    "policy": {
      "allowExecution": true,
      "onlyWhileCharging": false,
      "minimumBatteryPct": 15
    }
  }
  ```

### `GET /api/v1/nodes/:id/poll`
Pulls any dispatched workload assigned to this worker node (authenticated fallback).
- **Headers:** `Authorization: Bearer <auth_token>`
- **Response:** `200 OK`
  ```json
  {
    "job": {
      "job_id": "challenge_abcdef12",
      "workload_id": "challenge_sha256_abcdef",
      "lease_id": "lease_...",
      "fencing_token": "ft_...",
      "spec": { ... },
      "wasm_bytes": "<base64>"
    }
  }
  ```

### `POST /api/v1/nodes/ack`
Acknowledges workload lease receipt by the device. Transitions state: `DISPATCHED` → `ACKNOWLEDGED`.
- **Headers:** `Authorization: Bearer <auth_token>`, `Content-Type: application/json`
- **Request:**
  ```json
  {
    "node_id": "9c1820f9-0c70-498c-94a8-544e4c54e425",
    "job_id": "challenge_abcdef12",
    "fencing_token": "ft_..."
  }
  ```
- **Response:** `200 OK`
  ```json
  { "status": "acknowledged", "job_id": "challenge_abcdef12", "state": "ACKNOWLEDGED" }
  ```

### `POST /api/v1/nodes/start`
Confirms execution initiation on device. Transitions state: `ACKNOWLEDGED` → `RUNNING`.
- **Headers:** `Authorization: Bearer <auth_token>`, `Content-Type: application/json`
- **Request:**
  ```json
  {
    "node_id": "9c1820f9-0c70-498c-94a8-544e4c54e425",
    "job_id": "challenge_abcdef12",
    "fencing_token": "ft_..."
  }
  ```
- **Response:** `200 OK`
  ```json
  { "status": "started", "job_id": "challenge_abcdef12", "state": "RUNNING" }
  ```

### `POST /api/v1/nodes/results`
Submits execution receipt and output. Transitions: `RUNNING` → `RESULT_SUBMITTED` → `VERIFYING` → `VERIFIED` → `SETTLED` → `COMPLETED`.
- **Headers:** `Authorization: Bearer <auth_token>`, `Content-Type: application/json`
- **Request:**
  ```json
  {
    "node_id": "9c1820f9-0c70-498c-94a8-544e4c54e425",
    "job_id": "challenge_abcdef12",
    "fencing_token": "ft_...",
    "exit_code": 0,
    "stdout": "Digest: 7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069",
    "result_digest": "7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069",
    "fuel_used": 142000,
    "duration_ms": 284
  }
  ```
- **Response:** `200 OK`
  ```json
  {
    "status": "accepted",
    "job_id": "challenge_abcdef12",
    "state": "COMPLETED",
    "verification": "VERIFIED",
    "credits_settled": 15.68,
    "tx_id": "tx_..."
  }
  ```

### `POST /api/v1/nodes/:id/policy`
Updates safety policy overrides on a node (e.g. `onlyWhileCharging`).
- **Headers:** `Authorization: Bearer <admin_secret>`, `Content-Type: application/json`
- **Request:**
  ```json
  {
    "allowExecution": true,
    "onlyWhileCharging": false,
    "minimumBatteryPct": 15
  }
  ```

---

## 2. Challenge & Job Lifecycle Management

### `POST /api/v1/nodes/:id/dispatch-challenge`
Dispatches an authentic FIPS 180-4 SHA-256 WebAssembly challenge with an unpredictable nonce.
- **Headers:** `Authorization: Bearer <admin_secret>`
- **Response:** `200 OK`
  ```json
  {
    "status": "ok",
    "job_id": "challenge_abcdef12",
    "state": "DISPATCHED",
    "nonce": "ch_...",
    "expected_digest": "...",
    "assigned_node_id": "9c1820f9-0c70-498c-94a8-544e4c54e425",
    "lease_id": "lease_...",
    "fencing_token": "ft_...",
    "lease_expires_at": 1759114060000,
    "wss_pushed": true
  }
  ```

### `GET /api/v1/jobs/:id/trace`
Returns the complete 11-step chronological lifecycle trace for a job.
- **Response:** `200 OK`
  ```json
  {
    "job_id": "challenge_abcdef12",
    "current_state": "COMPLETED",
    "transitions": [
      { "from_state": null, "to_state": "CREATED", "reason": "Job initialized", "timestamp": 1759114000100 },
      { "from_state": "CREATED", "to_state": "QUEUED", "reason": "Placed in queue", "timestamp": 1759114000120 },
      { "from_state": "QUEUED", "to_state": "ASSIGNED", "reason": "Target node selected", "timestamp": 1759114000140 },
      { "from_state": "ASSIGNED", "to_state": "LEASED", "reason": "Lease issued", "timestamp": 1759114000160 },
      { "from_state": "LEASED", "to_state": "DISPATCHED", "reason": "Workload pushed via WSS", "timestamp": 1759114000180 },
      { "from_state": "DISPATCHED", "to_state": "ACKNOWLEDGED", "reason": "Device confirmed receipt", "timestamp": 1759114001200 },
      { "from_state": "ACKNOWLEDGED", "to_state": "RUNNING", "reason": "Device started WASM VM", "timestamp": 1759114001500 },
      { "from_state": "RUNNING", "to_state": "RESULT_SUBMITTED", "reason": "Result receipt posted", "timestamp": 1759114003000 },
      { "from_state": "RESULT_SUBMITTED", "to_state": "VERIFYING", "reason": "Digest validation", "timestamp": 1759114003020 },
      { "from_state": "VERIFYING", "to_state": "VERIFIED", "reason": "Digest match confirmed", "timestamp": 1759114003050 },
      { "from_state": "VERIFIED", "to_state": "SETTLED", "reason": "Double-entry ledger recorded", "timestamp": 1759114003070 },
      { "from_state": "SETTLED", "to_state": "COMPLETED", "reason": "Lifecycle completed", "timestamp": 1759114003090 }
    ]
  }
  ```

---

## 3. Observability & Double-Entry Accounting

### `GET /api/v1/metering`
Returns verifiable double-entry credit ledger records with balanced debit/credit pairing.

### `GET /api/v1/metering/consumer/:accountKey`
Returns specific account balance, credit/debit transaction history, and epoch.

### `GET /api/v1/ledger/download`
Downloads complete ledger as CSV for audit compliance.

### `GET /api/v1/system/health`
Returns system health, DO state, active/idle nodes, and epoch.
