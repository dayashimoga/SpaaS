# SPaaS Observability & Monitoring Specification

## 1. Prometheus Metrics Exposition

The SPaaS Control Plane natively exposes OpenMetrics / Prometheus formatted telemetry at `GET /metrics`. Metrics are served with negligible overhead via atomic counters and gauges managed by `crates/telemetry`.

### Comprehensive Metrics Catalog

| Metric Identifier | Metric Type | Labels | Description |
|---|---|---|---|
| `spaas_active_nodes` | Gauge | `environment` | Total number of registered edge nodes in `HEALTHY` or `DEGRADED` state. |
| `spaas_idle_nodes` | Gauge | `environment` | Available nodes ready to accept and execute dispatched workloads. |
| `spaas_offline_nodes` | Gauge | `environment` | Nodes that have exceeded the heartbeat timeout and transitioned to `OFFLINE`. |
| `spaas_queue_depth` | Gauge | `priority` | Number of submitted workloads awaiting scheduler candidate evaluation. |
| `spaas_running_jobs` | Gauge | `runtime` | Workloads currently executing inside edge sandboxes. |
| `spaas_completed_jobs_total` | Counter | `verification` | Cumulative count of cryptographically settled and completed workloads. |
| `spaas_failed_jobs_total` | Counter | `reason` | Cumulative count of failed workloads (e.g. `timeout`, `out_of_gas`, `verification_failure`). |
| `spaas_retried_jobs_total` | Counter | `reason` | Total retry attempts triggered by node dropout or execution faults. |
| `spaas_credits_transferred_total` | Counter | `tier` | Total TEST CREDITS transferred from consumers to volunteer node providers. |
| `spaas_scheduler_duration_seconds` | Histogram | `algorithm` | Latency distribution of scheduler ranking and candidate selection. |

---

## 2. Prometheus Scrape Configuration

To integrate SPaaS with an existing Prometheus monitoring instance, add the following job to `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'spaas-control-plane'
    scrape_interval: 5s
    scrape_timeout: 3s
    metrics_path: '/metrics'
    static_configs:
      - targets: ['control-plane:8080']
        labels:
          cluster: 'spaas-edge-cluster-01'
          region: 'us-west-edge'
```

---

## 3. Recommended Alerting Rules

Create the following PromQL alert rules in `rules/spaas-alerts.yml`:

```yaml
groups:
  - name: spaas-fabric-alerts
    rules:
      - alert: EdgeFleetDepleted
        expr: spaas_idle_nodes < 1 and spaas_queue_depth > 0
        for: 30s
        labels:
          severity: critical
        annotations:
          summary: "No idle edge compute nodes available"
          description: "Cluster has queued workloads but zero idle nodes ready to execute."

      - alert: HighJobFailureRate
        expr: rate(spaas_failed_jobs_total[5m]) / (rate(spaas_completed_jobs_total[5m]) + rate(spaas_failed_jobs_total[5m])) > 0.05
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Job failure rate exceeds 5%"
          description: "Abnormal rate of workload failures detected across the edge fleet."

      - alert: NodeOfflineSpike
        expr: increase(spaas_offline_nodes[5m]) > 5
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Sudden spike in offline edge nodes"
          description: "More than 5 nodes disconnected within 5 minutes."
```

---

## 4. Structured Logging & Distributed Tracing

The SPaaS control plane and node agent use `tracing` and `tracing-subscriber` for hierarchical, structured logging:

### Log Formatting
- **Standard Console**: Human-readable, colorized output for local development.
- **Production JSON**: Configured when `SPAAS_LOG_FORMAT=json` for direct ingestion into Elasticsearch, Loki, or Datadog.

### Contextual Fields
Every log entry automatically carries context for end-to-end correlation:
- `trace_id`: Distributed trace identifier across control plane and node agent.
- `job_id`: Unique identifier for the workload being scheduled or executed.
- `node_id`: Target node identifier for heartbeats, qualifications, or lease grants.
- `client_ip`: Origin IP address of the requesting client.
