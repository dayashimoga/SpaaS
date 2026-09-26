# SPaaS Production Deployment Guide

## 1. Architecture & System Topology
The SPaaS Universal Edge Compute Fabric is engineered for deployment across diverse infrastructure targets, from single-node edge servers and on-premises workstations to multi-region cloud virtual machines.

The standard production deployment consists of:
- **Control Plane (`apps/control-plane`)**: High-throughput Axum HTTP/SSE server orchestrating cluster state, cryptographic node enrollment, scheduling, and dual-entry accounting.
- **Web Management Console (`apps/web-console`)**: High-performance dashboard providing real-time fleet visualization, interactive workload studio, and telemetry inspection.
- **Node Agent (`crates/node-agent`)**: Lightweight volunteer daemon running on consumer desktops or edge servers.
- **Android Node (`apps/android-node`)**: Android foreground service executing WASM workloads on voluntary smartphones.

---

## 2. Environment Variables & Configuration

The SPaaS control plane accepts configuration via environment variables or command-line flags:

| Variable | Default Value | Description |
|---|---|---|
| `SPAAS_BIND_ADDR` | `0.0.0.0:8080` | Network socket address for HTTP and SSE listeners. |
| `SPAAS_DATA_DIR` | `./data` | Directory path for write-ahead log (WAL), keypair storage, and audit logs. |
| `SPAAS_AUTH_TOKEN` | `""` (Open dev mode) | Bearer token for authenticating administrative and job submission API requests. |
| `SPAAS_RATE_LIMIT_RPS`| `100` | Token bucket rate limit per client IP (requests per second). |
| `SPAAS_HEARTBEAT_TIMEOUT_MS` | `10000` | Inactivity window before an unresponsive node transitions to `OFFLINE`. |
| `SPAAS_LEASE_TIMEOUT_MS` | `30000` | Lease duration granted to a node for executing a scheduled workload. |
| `RUST_LOG` | `info,spaas_control_plane=debug` | Tracing filter for structured JSON/standard logging. |

---

## 3. Containerized Deployment (Rootless Podman / Docker)

### Podman Compose
To launch the complete SPaaS cluster stack using rootless Podman:

```bash
# 1. Clone repository and navigate to deployment directory
git clone https://github.com/dayashimoga/SpaaS.git
cd SpaaS

# 2. Launch cluster via Podman Compose
podman compose -f deploy/podman-compose.yml up -d

# 3. Verify container statuses
podman compose -f deploy/podman-compose.yml ps
```

### Persistent Volume Configuration
Ensure persistent directories have appropriate user permissions for rootless container execution:
```bash
mkdir -p data/wal data/backups
chmod 700 data
podman volume create spaas-data
```

---

## 4. Bare-Metal & Systemd Service Deployment

For native Linux edge gateways and servers without container overhead:

### Compile Release Binary
```bash
cargo build --release -p spaas-control-plane
sudo cp target/release/spaas-control-plane /usr/local/bin/
```

### Systemd Service Configuration (`/etc/systemd/system/spaas.service`)
```ini
[Unit]
Description=SPaaS Universal Edge Compute Control Plane
After=network.target

[Service]
Type=simple
User=spaas
Group=spaas
WorkingDirectory=/var/lib/spaas
ExecStart=/usr/local/bin/spaas-control-plane --bind 0.0.0.0:8080 --data-dir /var/lib/spaas/data
Restart=always
RestartSec=5
LimitNOFILE=65536
Environment=RUST_LOG=info
Environment=SPAAS_DATA_DIR=/var/lib/spaas/data

[Install]
WantedBy=multi-user.target
```

Enable and start the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now spaas.service
sudo systemctl status spaas.service
```

---

## 5. Reverse Proxy & TLS Termination

Production installations should terminate TLS via a reverse proxy (e.g., Caddy or Nginx) to enforce HTTPS and WSS connections.

### Caddyfile Example
```caddy
spaas.example.com {
    reverse_proxy localhost:8080 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
}
```

### Nginx Example
```nginx
server {
    listen 443 ssl http2;
    server_name spaas.example.com;

    ssl_certificate /etc/letsencrypt/live/spaas.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/spaas.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_buffering off; # Required for SSE streaming (/api/v1/events)
        proxy_read_timeout 86400s;
    }
}
```

---

## 6. Health Checks & Monitoring Endpoints

- **Liveness Probe**: `GET http://<host>:8080/health` (Returns HTTP 200 OK with uptime)
- **Detailed System Health**: `GET http://<host>:8080/api/v1/system/health`
- **Prometheus Metrics**: `GET http://<host>:8080/metrics`
- **Live SSE Event Stream**: `GET http://<host>:8080/api/v1/events`
