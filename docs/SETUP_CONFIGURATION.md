# SPaaS Setup & Configuration Manual

## 1. Environment Variables

### Control Plane (`spaas-control-plane`)
| Variable | Default | Description |
| :--- | :--- | :--- |
| `HOST` | `0.0.0.0` | Listen IP address |
| `PORT` | `8080` | Listen HTTP port |
| `RUST_LOG` | `info` | Tracing log filter (`trace`, `debug`, `info`, `warn`, `error`) |

### Ingress Gateway (`spaas-gateway`)
| Variable | Default | Description |
| :--- | :--- | :--- |
| `HOST` | `0.0.0.0` | Ingress listen IP |
| `PORT` | `8000` | Ingress listen port |
| `UPSTREAM_URL` | `http://127.0.0.1:8080` | Upstream Control Plane address |

### Developer CLI (`spaas`)
| Variable | Default | Description |
| :--- | :--- | :--- |
| `SPAAS_API_URL`| `http://127.0.0.1:8080` | Target control plane endpoint |

---

## 2. Podman Container Configuration
The deployment configuration resides in `deploy/podman-compose.yml`. Networking uses rootless bridge networking via `netavark`.
