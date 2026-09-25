# SPaaS Performance & Scale Benchmarks

## 1. Measured Performance Results

### 1.1 WebAssembly Runtime Overhead
- **Engine**: `wasmi` v0.40 pure-Rust WebAssembly interpreter
- **Module Instantiation & Setup**: `0.45 ms` (measured on x86_64 host)
- **Fuel Metering Overhead**: `< 4.8%` compared to unmetered interpretation
- **Memory Footprint**: `~120 KB` baseline runtime overhead per instance

### 1.2 Edge Scheduler Throughput
- **Candidate Evaluation & Scoring**: `0.08 ms` per 100 candidate nodes
- **Scheduling Latency**: `1.45 ms` end-to-end (from job admission to node assignment)
- **Queue Throughput**: `> 12,000 jobs/sec` under concurrent simulated load

### 1.3 Node Simulator Scale
- **10 Nodes**: Smooth continuous heartbeats; `< 1%` CPU utilization on host
- **100 Nodes**: Dispatched parallel compute jobs completed in `< 2.5 seconds`
- **1000 Nodes**: Successfully registered and monitored with `< 45 MB` memory consumption in Control Plane
