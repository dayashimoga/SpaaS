# SPaaS Intelligent Edge Scheduler Specification

## 1. Multi-Criteria Scheduling Architecture

The SPaaS Edge Scheduler (`crates/scheduler-core`) coordinates compute placement across heterogeneous, mobile, and intermittently connected volunteer devices. Workload assignment utilizes a rigorous two-phase pipeline: **Hard Constraint Filtering** followed by **Multi-Attribute Pareto Scoring**.

```
[ Incoming Workload ]
         │
         ▼
┌─────────────────────────────────┐
│   Phase 1: Filter Pipeline      │  Rejects ineligible nodes with explicit
│   (Hard Constraint Validation)  │  reasons (Architecture, Battery, Thermals, Region)
└─────────────────────────────────┘
         │ Eligible Nodes
         ▼
┌─────────────────────────────────┐
│   Phase 2: Multi-Attribute      │  Computes scalar score based on MIPS,
│   Weighted Scoring Engine       │  Thermals, Network RTT, Cost, & Reliability
└─────────────────────────────────┘
         │ Highest Scoring Candidate
         ▼
[ Mutual Lease Grant & Dispatch ]
```

---

## 2. Phase 1: Hard Eligibility Filter Rules & Rejection Reasons

Every candidate node is evaluated against strict eligibility criteria. Failing any check immediately disqualifies the node and logs an explicit rejection code:

| Filter Rule | Rejection Code | Description & Validation Constraint |
|---|---|---|
| **Enrollment Status** | `NodeNotEnrolled` | Node must be in active registered state (not `Unenrolled`). |
| **Operational State** | `NodeOffline` / `NodePaused` | Node must be `Idle` or `Active` (missed heartbeats or manual pause reject node). |
| **Architecture Match** | `ArchitectureMismatch` | Node CPU architecture must be present in `spec.required_capabilities.architectures`. |
| **Memory Headroom** | `InsufficientMemory` | Node available RAM must meet or exceed `spec.required_capabilities.min_ram_mb`. |
| **Battery Floor** | `InsufficientBattery` | Current battery % must be $\ge \max(\text{spec.min\_battery}, \text{node.policy.min\_battery})$. |
| **Charging Policy** | `ChargingRequired` | If workload or node policy mandates charging, `charging_state` must be true. |
| **Network Type** | `UnmeteredNetworkRequired` | If required, node must be connected to unmetered Wi-Fi/Ethernet (not cellular). |
| **Thermal Threshold** | `ThermalThrottled` | Node thermal state must not exceed `node.policy.max_thermal_threshold`. |
| **Geographic Region** | `RegionMismatch` | Node region must match `spec.preferred_regions` if non-empty. |
| **Workload Category** | `CategoryNotAllowed` | Workload category (e.g. `heavy_compute`) must be permitted by node policy. |
| **Deadline Feasibility**| `DeadlineInfeasible` | Estimated execution time must not exceed `spec.deadline_ms`. |
| **Cost Ceiling** | `CostExceedsMax` | Estimated execution cost must not exceed `spec.max_cost_credits`. |

---

## 3. Phase 2: Multi-Attribute Scoring Engine

Candidate nodes that satisfy all hard filters receive a composite scalar score ($0.0 \text{ to } 100.0+$):

$$\text{Score} = w_{\text{mips}} S_{\text{mips}} + w_{\text{chg}} S_{\text{chg}} + w_{\text{bat}} S_{\text{bat}} + w_{\text{thm}} S_{\text{thm}} + w_{\text{net}} S_{\text{net}} + w_{\text{rel}} S_{\text{rel}} + w_{\text{cost}} S_{\text{cost}} - w_{\text{load}} P_{\text{load}}$$

### Configurable Weights & Attributes
- **MIPS Throughput ($w_{\text{mips}} = 0.20$)**: Measured fuel-processing capacity from empirical qualification.
- **Charging State ($w_{\text{chg}} = 0.20$)**: High preference for AC-powered or wirelessly docked devices.
- **Battery Headroom ($w_{\text{bat}} = 0.15$)**: Proportional score based on available charge level ($20\% \to 100\%$).
- **Thermal Margin ($w_{\text{thm}} = 0.15$)**: Penalizes elevated temperatures (`NOMINAL` = 1.0, `MODERATE` = 0.7, `SEVERE` = 0.0).
- **Network Latency ($w_{\text{net}} = 0.10$)**: Normalized RTT to control plane and workload artifact store.
- **Provider Reliability ($w_{\text{rel}} = 0.10$)**: Historical success ratio over past 100 assigned jobs.
- **Cost Efficiency ($w_{\text{cost}} = 0.05$)**: Lower credits per fuel instruction executed.
- **Current Load Penalty ($w_{\text{load}} = 0.05$)**: Avoids overloading nodes already executing active tasks.

---

## 4. Execution Time & Cost Estimation

Before dispatch, the scheduler computes upfront estimates:
- **Estimated Execution Time**:
  $$\text{est\_execution\_ms} = \max\left(10, \frac{\text{max\_fuel}}{\text{measured\_fuel\_mips} \times 1,000}\right)$$
- **Estimated Cost**:
  $$\text{est\_cost\_credits} = \text{base\_fee} + \left\lceil \frac{\text{max\_fuel}}{100,000} \right\rceil$$

These values are recorded on the `JobRecord` and returned in the scheduling decision API.

---

## 5. Transparent Scheduler Explainability API

SPaaS provides 100% explainability for every scheduling decision via `GET /api/v1/jobs/:id/scheduler-decision`:

```json
{
  "job_id": "job-wasm-primes-9c41",
  "assigned_node_id": "node-android-pixel8-7f2a",
  "evaluated_at_ms": 1727350000000,
  "total_candidates_evaluated": 12,
  "eligible_candidates_count": 4,
  "top_ranked_candidates": [
    {
      "node_id": "node-android-pixel8-7f2a",
      "total_score": 88.4,
      "mips_score": 92.0,
      "thermal_score": 100.0,
      "battery_score": 85.0,
      "estimated_execution_ms": 420,
      "estimated_cost_credits": 25
    }
  ],
  "rejection_reasons": {
    "node-desktop-win-3b1a": "RegionMismatch",
    "node-phone-galaxy-0e12": "InsufficientBattery (18% < 30%)"
  }
}
```
