# SPaaS Setup & Configuration Reference Manual

## 1. Configuration Architecture

The SPaaS Universal Edge Compute Fabric supports hierarchical configuration via environment variables, CLI command arguments, and persistent state files. All configuration settings are validated at startup with descriptive error messages if constraints are violated.

---

## 2. Control Plane Configuration Reference

| Environment Variable | CLI Flag Equivalent | Default Value | Description & Constraints |
|---|---|---|---|
| `SPAAS_BIND_ADDR` | `--bind <ADDR>` | `0.0.0.0:8080` | IPv4/IPv6 socket address for HTTP, REST API, and SSE event streaming. |
| `SPAAS_DATA_DIR` | `--data-dir <PATH>` | `./data` | Directory where Write-Ahead Log (WAL), server cryptographic keys, and backups are stored. |
| `SPAAS_AUTH_TOKEN` | `--auth-token <TOKEN>` | `""` (Dev Mode) | Bearer token required for protected administrative and job submission endpoints. |
| `SPAAS_RATE_LIMIT_RPS`| `--rate-limit <RPS>` | `100` | Ingress token-bucket rate limit per client IP address. |
| `SPAAS_HEARTBEAT_TIMEOUT_MS` | `--heartbeat-timeout <MS>`| `10000` | Inactivity threshold before an uncontacted node is transitioned to `OFFLINE`. |
| `SPAAS_LEASE_TIMEOUT_MS` | `--lease-timeout <MS>` | `30000` | Execution lease duration granted to a worker node for a scheduled job. |
| `SPAAS_SIMULATION_ACTIVE` | `--simulation` | `false` | When true, spawns heterogeneous synthetic worker nodes for testing and benchmarks. |
| `RUST_LOG` | N/A | `info` | Structured tracing filter directive (e.g. `debug,spaas_control_plane=trace`). |

---

## 3. Desktop / Edge Node Agent Configuration

When running the standalone Rust volunteer worker daemon (`crates/node-agent`):

### Command-Line Arguments
```bash
spaas-node-agent \
  --control-plane-url http://192.168.1.100:8080 \
  --device-name "LivingRoom-Desktop" \
  --require-charging \
  --min-battery 30 \
  --max-thermal MODERATE
```

### Configuration File (`spaas-agent.toml`)
```toml
[network]
control_plane_url = "http://127.0.0.1:8080"
heartbeat_interval_ms = 5000
request_timeout_ms = 8000

[policy]
require_charging = true
require_unmetered_network = true
min_battery_pct = 25
max_thermal_level = "MODERATE"
max_concurrent_jobs = 1

[hardware]
override_model_name = "Workstation-Ryzen9"
measured_fuel_mips = 320.5
```

---

## 4. Web Management Console Configuration

The web frontend (`apps/web-console`) is served as static HTML/CSS/JS. It can connect to local or remote control planes via configurable settings:

- **Local Storage API Override**: Open browser developer console or web console Settings tab and set:
  ```javascript
  localStorage.setItem('spaas_api_url', 'http://control-plane.example.com:8080');
  ```
- **Consumer Public Key Storage**: The web console generates and persists a consumer Ed25519 identity under `spaas_consumer_pubkey` to attribute submitted workloads and track credit balances.

---

## 5. Storage Directory Hierarchy

A standard production data directory contains:
```
data/
├── server_key.json         # Persisted Ed25519 server keypair (mode 600)
├── wal/                    # Write-Ahead Log state transitions
│   └── 00000001.wal        # Monotonic commit log files
└── backups/                # Periodic snapshots for disaster recovery
    └── state-snapshot.json
```
Ensure that `data/` has read and write permissions for the user executing the SPaaS service.
