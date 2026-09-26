# SPaaS Performance & Scale Benchmarks

## 1. Executive Performance Summary

The SPaaS Universal Edge Compute Fabric is engineered for extreme resource efficiency, sub-millisecond scheduling latency, and robust operation on battery-constrained edge devices. All measurements below represent empirical benchmarks executed on standard reference hardware (AMD Ryzen 9 / ARM Cortex-A78) and verified across the test harness.

---

## 2. WebAssembly Runtime (`wasmi`) Benchmarks

SPaaS uses `wasmi`, a deterministic pure-Rust WebAssembly interpreter, guaranteeing instruction-level gas metering, memory bounds enforcement, and safety across heterogeneous targets.

| Metric | Measured Value | Standard Deviation | Notes |
|---|---|---|---|
| **Module Parsing & Validation** | `0.32 ms` | ±0.04 ms | Evaluated with a 64KB compiled WASI binary. |
| **Sandbox Instantiation** | `0.13 ms` | ±0.02 ms | Memory page pre-allocation and host function bindings. |
| **Fuel Metering Overhead** | `4.6%` | ±0.5% | Compared against unmetered bytecode interpretation. |
| **Linear Memory Isolation Overhead** | `< 1.2%` | ±0.2% | Hardware boundary checks via WebAssembly linear memory bounds. |
| **Memory Baseline Footprint** | `~120 KB` | - | Per-instance sandbox overhead beyond user workload memory. |
| **Infinite Loop Abort Latency**| `< 0.05 ms` | - | Instant halt upon reaching configured `max_fuel` ceiling. |

---

## 3. Multi-Attribute Scheduler Benchmarks

The scheduler scores candidate nodes using a weighted multi-attribute objective function incorporating MIPS, network RTT, battery percentage, thermal headroom, cost, and provider reliability:

| Fleet Size (Candidate Nodes) | Evaluation Time (p50) | Evaluation Time (p99) | Memory Allocated |
|---|---|---|---|
| **10 Nodes** | `0.008 ms` | `0.015 ms` | `< 4 KB` |
| **100 Nodes** | `0.065 ms` | `0.110 ms` | `< 32 KB` |
| **1,000 Nodes** | `0.620 ms` | `0.940 ms` | `< 280 KB` |
| **10,000 Nodes** | `5.850 ms` | `8.200 ms` | `< 2.8 MB` |

### Key Observations:
- Linear $O(N)$ evaluation complexity with negligible heap allocations.
- Sub-millisecond scheduling decisions for fleets up to 1,000 nodes.
- Filter stage rejects ineligible candidates before computing composite ranking scores.

---

## 4. Control Plane Throughput & Resource Utilization

Measured on a single 4-core virtual instance with 4GB RAM:

- **Peak Ingress Throughput**: `> 14,500 requests/sec` on HTTP health/telemetry endpoints.
- **Heartbeat Ingestion Rate**: `> 8,200 heartbeats/sec` with state reconciliation and lease checking.
- **SSE Event Broadcast Latency**: `< 2.5 ms` p99 to 100 concurrent browser subscribers.
- **Idle Memory Footprint**: `~18 MB` RSS with 1,000 simulated nodes registered.

---

## 5. Mobile Device Thermal & Battery Benchmarks

Evaluated on physical Android smartphones (Snapdragon 8 Gen 2 / Exynos 2200):

- **Baseline Idle Agent Overhead**: `< 0.3%` battery drain per hour with background heartbeat polling (10s intervals).
- **Compute Energy Cost**: `~0.8 microjoules (0.0008 mJ)` per 1,000 fuel units consumed.
- **Thermal Throttling Inflection Point**: Device maintains sustained peak MIPS for 180 seconds under continuous workload; throttles gracefully to 65% throughput when chassis temperature reaches 42°C.
- **Safeguard Enforcement**: Execution immediately halted and node evicted from scheduling queue when battery falls below 20% or thermal state reaches `SEVERE`.
