# SPaaS Intelligent Edge Scheduler

## 1. Multi-Criteria Scheduling Architecture

The `EdgeScheduler` executes a two-phase decision process: **Hard Filtering** followed by **Multi-Attribute Weighted Scoring**.

---

## 2. Phase 1: Hard Eligibility Filtering
Candidate nodes must pass all criteria or be rejected immediately:
1. **Enrollment**: Node must be `Enrolled`.
2. **Operational State**: Node must be `Idle` or `Active` (not `Paused` or `Offline`).
3. **Owner Policy**: `is_user_paused` must be false.
4. **Capacity**: `active_job_count < max_concurrent_jobs`.
5. **Architecture**: Node architecture (`aarch64`, `x86_64`) must match `spec.required_capabilities.architectures`.
6. **RAM**: `available_ram_mb >= spec.required_capabilities.min_ram_mb`.
7. **Battery**: `battery_pct >= max(spec.min_battery, node.policy.min_battery)`.
8. **Charging**: If required, `charging_state.is_charging()` must be true.
9. **Network**: If required, `network_type.is_unmetered()` must be true.
10. **Thermals**: `thermal_status <= node.policy.max_thermal_threshold`.

---

## 3. Phase 2: Multi-Attribute Scoring

Eligible nodes receive a scalar score (0.0 to 100.0+) according to the formula:

$$\text{Score} = w_{\text{chg}} S_{\text{chg}} + w_{\text{bat}} S_{\text{bat}} + w_{\text{thm}} S_{\text{thm}} + w_{\text{net}} S_{\text{net}} + w_{\text{rel}} S_{\text{rel}} + w_{\text{lat}} S_{\text{lat}} - w_{\text{load}} P_{\text{load}}$$

### Default Weights:
- **Charging ($w_{\text{chg}}$)**: `0.25`
- **Battery ($w_{\text{bat}}$)**: `0.15`
- **Thermals ($w_{\text{thm}}$)**: `0.20`
- **Network Transport ($w_{\text{net}}$)**: `0.15`
- **Reliability History ($w_{\text{rel}}$)**: `0.15`
- **Latency ($w_{\text{lat}}$)**: `0.05`
- **Current Load Penalty ($w_{\text{load}}$)**: `0.05`
