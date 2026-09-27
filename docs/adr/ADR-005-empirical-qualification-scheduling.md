# ADR-005: Empirical Hardware Capability Discovery & Transparent Multi-Objective Scheduling

**Status:** Accepted  
**Date:** 2026-09-27  
**Deciders:** Principal Distributed Systems Architect, Rust Systems Engineer, QA Lead  

## Context
Edge compute fabrics span vast heterogeneity: high-end flagship smartphones (Snapdragon 8 Gen 3), mid-range devices, low-power desktop workers, and headless servers. Previous systems frequently relied on static OS property queries (e.g. checking if a Vulkan driver library was present) and assigned generic universal scores. This led to misplacing heavy matrix workloads on thermally constrained devices or claiming unproven NPU acceleration.

## Decision
We implement **Empirical Hardware Benchmarking and Workload-Aware Multi-Objective Scheduling**:
1. **Empirical Microbenchmarking Suite:**
   - Upon initial enrollment and on-demand requalification, nodes execute resource-bounded benchmarks:
     - **CPU Integer:** Fixed-iteration prime sieve calculating effective MIPS.
     - **Floating Point:** Matrix multiplication benchmark calculating MFLOPS.
     - **WASM Virtual Machine:** Bytecode instruction execution rate (fuel/ms).
     - **Memory:** Sequential read/write buffer allocations (MB/s).
     - **Network:** Outbound ping and TLS payload round-trip time (RTT in ms).
   - Raw measurements, benchmark version, timestamp, battery level, and thermal state are recorded in `NodeQualificationProfile`.
2. **Honest Accelerator Reporting:**
   - Accelerators (GPU, NPU, DSP) are strictly labeled `UNKNOWN` or `UNTESTED` unless an authentic compute shader (Vulkan/RenderScript) or neural model (NNAPI) executes successfully and passes digest verification.
   - Capability vectors explicitly report status: `PROVEN`, `SUPPORTED`, or `UNTESTED`.
3. **Hard Constraint Gating:**
   - Before ranking, the scheduler eliminates non-viable candidates:
     - Workload memory requirement <= available free RAM.
     - Target architecture match (`aarch64`, `x86_64`, or universal `wasm32`).
     - Owner restrictions: battery level >= minimum threshold, charging state, network type (unmetered Wi-Fi vs cellular).
4. **Transparent "Why This Device?" Explainability:**
   - The scheduler computes a normalized Pareto score across live capacity, latency, historical reliability, and energy efficiency.
   - Returns a structured `SchedulerDecision` containing:
     - Selected node ID and name.
     - Ranked list of top candidate nodes with composite scores.
     - List of rejected nodes with specific failed constraints (e.g. `INSUFFICIENT_BATTERY`, `CHARGING_REQUIRED`).
     - Estimated queue wait, network transfer, execution duration, and test credits.

## Consequences
### Positive:
- Zero fabricated benchmarks or misleading accelerator claims.
- High scheduling fairness and optimal workload placement.
- Complete transparency for developers: eliminates black-box scheduling confusion.
- Resilient to thermal throttling via dynamic capacity decay formulas.

### Negative / Trade-offs:
- Initial device qualification takes 2-4 seconds during first enrollment.
