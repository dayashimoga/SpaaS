# SPaaS Observability & Monitoring

## 1. Metrics Exposition
The Control Plane exposes Prometheus-compatible metrics at `GET /metrics`.

### Key Metrics Tracked
| Metric Name | Type | Description |
| :--- | :--- | :--- |
| `spaas_active_nodes` | Gauge | Currently enrolled active edge nodes |
| `spaas_idle_nodes` | Gauge | Available idle nodes ready to accept workloads |
| `spaas_offline_nodes` | Gauge | Nodes currently disconnected or unreachable |
| `spaas_queue_depth` | Gauge | Workloads currently queued awaiting scheduling |
| `spaas_running_jobs` | Gauge | Workloads executing inside sandboxes |
| `spaas_completed_jobs_total` | Counter | Successfully verified and completed jobs |
| `spaas_failed_jobs_total` | Counter | Terminal unrecoverable job failures |
| `spaas_retried_jobs_total` | Counter | Total job rescheduling and retry attempts |
| `spaas_credits_transferred_total` | Counter | Total compute units transferred to providers |

---

## 2. Distributed Tracing & Correlation IDs
Every incoming API request is tagged with a `CorrelationContext` containing a `trace_id` and `request_id`. Traces propagate through logs to simplify cross-service debugging.
