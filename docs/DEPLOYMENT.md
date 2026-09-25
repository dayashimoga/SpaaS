# SPaaS Production Deployment Guide

## 1. Containerized Podman Deployment
SPaaS components are distributed as container images:
- `spaas/control-plane:latest`: Axum-based core orchestrator
- `spaas/gateway:latest`: Ingress reverse proxy
- `spaas/web-console:latest`: Nginx static asset server
- `spaas/node-simulator:latest`: Distributed simulation daemon

---

## 2. Podman Compose Deployment
To launch on a production server:
```bash
podman compose -f deploy/podman-compose.yml up -d
```

### Health Checks
- Control Plane: `http://<host>:8080/api/v1/system/health`
- Gateway: `http://<host>:8000/api/v1/system/health`
- Prometheus Metrics: `http://<host>:8080/metrics`

---

## 3. Production Hardening Checklist
- [x] Configure TLS certificates on Ingress Gateway
- [x] Set environment variable `RUST_LOG=info`
- [x] Configure Podman rootless user execution
- [x] Mount persistent volumes for audit log archiving
- [x] Set up Prometheus and Grafana alerts for `spaas_offline_nodes` and `spaas_failed_jobs_total`
