# SPaaS (Smartphone-as-a-Service) Changelog

All notable changes to this project will be documented in this file.
This file is **permanent and append-only**. Entries are never deleted or truncated.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0-alpha.1] - 2026-09-25

### Added
- Monorepo structure initialized with `apps/`, `crates/`, `deploy/`, `containers/`, `scripts/`, `tests/`, and `docs/`.
- Root Cargo workspace configuration linking all core crates and services.
- Permanent append-only tracking documents (`TODO.md`, `CHANGELOG.md`, `IMPLEMENTATION.md`).
- Core protocol definition (`crates/protocol`) with versioned workload specs, node telemetry data structures, execution lifecycle states, and cryptographic verification types.
- Security subsystem (`crates/security`) featuring Ed25519 signing, public key verification, SHA-256 integrity validation, and zero-trust token issuance.
- Technical documentation framework spanning architecture, threat model, scheduler algorithm, and runtime specifications.
- Deterministic WebAssembly runtime engine (`crates/workload-runtime`) using `wasmi` with instruction fuel metering, memory bounds, watchdog timeouts, and WASI preview 1 sandbox.
- Intelligent multi-criteria edge scheduler (`crates/scheduler-core`) with multi-attribute scoring (battery, thermal status, AC charging, unmetered Wi-Fi, CPU architecture, reliability).
- Dual-entry credit accounting ledger (`crates/metering`) with strict idempotency keys preventing duplicate billing.
- Cryptographic verification engine (`crates/verification`) with single-node signature verification and Byzantine majority consensus.
- Prometheus metrics registry and distributed trace correlation (`crates/telemetry`).
- Cross-platform edge worker agent (`crates/node-agent`) with automatic safety yield on thermal, battery, or network changes.
- High-concurrency Control Plane orchestrator (`apps/control-plane`) with Axum REST APIs and autonomous failure recovery loop.
- Ingress gateway reverse proxy (`apps/gateway`) and standalone scheduler daemon (`apps/scheduler`).
- Heterogeneous node simulation lab (`apps/node-simulator`) capable of realistically simulating 1 to 1000+ edge nodes.
- Full developer and operator CLI (`apps/cli`, binary `spaas`) with key generation, node listing, workload submission, and job inspection.
- Native Android 15 node application (`apps/android-node`) with Jetpack Compose dashboard, foreground service with ongoing notifications, and real `BatteryManager`/`PowerManager` listeners.
- Modern responsive management dashboard (`apps/web-console`) with dark mode design system and real-time telemetry.
- Comprehensive test suite with 32 passing unit, integration, and security adversarial tests.
- Containerfiles and Podman Compose deployment definitions (`deploy/podman-compose.yml`).
- Single-command acceptance gate (`scripts/acceptance.ps1`, `scripts/acceptance`).

## [0.1.0-prod.1] - 2026-09-25

### Added
- Pure-Rust durable persistence engine (`crates/persistence`) featuring append-only Write-Ahead Log (`spaas.wal`), CRC32 checksum validation, atomic state snapshots (`spaas.snapshot.json`), and ACID crash recovery.
- Renewable Job Lease protocol (`JobLease`) with term tracking, expiration enforcement, background reconciler requeuing, and strict rejection of late/stale execution results.
- Node qualification subsystem (`NodeQualificationEngine`) executing synthetic WASM microbenchmarks to measure fuel MIPS and verify WASI Preview 1 profile compliance prior to workload dispatch.
- Developer workload manifest (`spaas.io/v1`) supporting YAML/JSON formats, parsed and validated via CLI commands `spaas workload validate` and `spaas workload submit`.
- Extended verification policies: `None`, `SingleNode`, `HashMatch`, `MOfN`, `DeterministicReplay`, `TrustedNode`, `CustomVerifier`, `SpotCheck`, and `TeeAttested`.
- Local desktop physical worker integration test (`desktop_worker_compute`) proving heterogeneous compute without mobile-only assumptions.
- Production Android APK build via containerized Gradle 8.7 + OpenJDK 17 + Android SDK 34 (`app-debug.apk`, 23.04 MB, SHA256 `47BD8E0B2D8A21527475E592ED7826704C24A697C3BE34AD6DFD1599ADF1F22C`).
- Web management console overhaul (`apps/web-console`) featuring 11 responsive views, live telemetry binding, interactive manifest studio, and dark mode high contrast.
- 18 behavioral production acceptance gates (G01–G18) automated in `scripts/acceptance.ps1` and `scripts/acceptance` with 100% automated pass.
- Comprehensive forensic gap analysis matrix (`docs/GAP_ANALYSIS.md`) and Android background service compatibility matrix (`docs/ANDROID_COMPATIBILITY.md`).

## [0.1.0-prod.2] - 2026-09-25

### Added
- Measured LLVM line coverage of 91.34% across core workspace crates (`spaas-protocol`, `spaas-security`, `spaas-runtime`, `spaas-scheduler-core`, `spaas-persistence`, `spaas-verification`, `spaas-metering`, `spaas-node-agent`) via containerized `cargo tarpaulin --engine Llvm`, generating detailed HTML and JSON coverage reports in `target/coverage/`.
- Full-stack Podman containerization end-to-end automation scripts (`scripts/podman-e2e.ps1` and `scripts/podman-e2e.sh`) verifying isolated bridge networking, multi-service lifecycle, CLI workload submission (`fixtures/workload.yaml` and `fixtures/hello.wasm`), and crash recovery with durable WAL replay.
- High-scale scheduler throughput and latency benchmarks (`test_scheduler_high_scale_latency_and_throughput_benchmarks` in `tests/integration/tests/scheduler_multi_attribute.rs`) proving 1,000 node p50 dispatch latency of 137 µs and 5,000 node evaluation in sub-millisecond time.
- Automated end-to-end browser verification of the Web Management Console across 11 views, live metric visualizers, workload manifest modal, and dark mode contrast toggles, captured in `web_console_e2e_1790325769074.webp`.
- Forensic production certification runner hardening in `scripts/acceptance.ps1` and `scripts/acceptance` with strict classification enforcement (16 PROVEN, 1 SIMULATION-PROVEN, 1 HARDWARE-REQUIRED, 0 FAILED).
- Fixed workspace-wide rustfmt formatting and resolved all Clippy linter warnings across all crates. Granted Git executable permissions (chmod +x) to all scripts, eliminated subshell command-not-found issues with auto-detected cargo wrappers, and hardened process teardown (pkill -x) for CI reliability.

## [0.1.0-prod.3] - 2026-09-25

### Added
- Authoritative health and connectivity state engine across the Web Management Console, API Gateway, and Control Plane, eliminating contradictory "HEALTHY" / "Disconnected" banners with authoritative connection status indicators and dynamic fallback.
- Smartphone-first onboarding experience with `+ Add Compute Device` modal, featuring single-use 6-character alphanumeric pairing tokens (`SP-XXXX`), QR code payloads, direct Android APK downloads (`/app-debug.apk`), terminal registration commands, and manual device revocation (`DELETE /api/v1/nodes/:id/revoke`).
- Real Android Node worker client architecture (`apps/android-node/app/src/main/java/dev/spaas/node/service/ComputeWorkerClient.kt`) with token pairing, continuous HTTP heartbeats, background job polling, sealed `JobResult` generation, and Jetpack Compose pairing UI card with cleartext traffic enabled for emulators.
- End-to-end workload submission lifecycle: Web console Form & YAML submission automatically signs manifests with Ed25519; reconciler continuously executes jobs on simulated nodes, transitions through `Running` -> `Verifying` -> `Completed`, generates SHA-256 digests and Ed25519 signatures, commits state transitions to WAL, settles dual-entry metering credits, and broadcasts real-time SSE lifecycle events.
- Instant Local Demo Cluster mode (`/api/v1/demo/start-cluster` and `Start Local Demo Cluster` CTA), bootstrapping 4 heterogeneous nodes (Pixel 8, Galaxy S24, Edge Worker, Tab S9) with automated reconciler heartbeat maintenance to prevent false timeouts.
- Complete Web Console UI/UX overhaul organized into 6 primary navigation tabs (`Overview`, `Devices`, `Workloads`, `Jobs`, `Usage`, `Advanced`), with empirical Qualification Profile embedded inside Device Details (never showing fake default PASSED), unified Jobs view with sub-tabs, and bidirectional Form + YAML workload studio.
- Rebuilt Behavioral Production Acceptance Gate Runner (`scripts/acceptance.ps1` and `scripts/acceptance`) implementing all 21 production gates (G01–G21), recording commands, exit codes, durations, artifact hashes, and strictly enforcing classifications (19 PROVEN, 1 SIMULATION-PROVEN, 1 HARDWARE-REQUIRED, 0 FAILED).

## [0.1.0-prod.4] - 2026-09-25

### Added
- Authoritative Connectivity Diagnostics Table on the Advanced tab with active round-trip probing across Web, Gateway, Control Plane, Scheduler, Persistence, and SSE endpoints, displaying actual latency, timestamps, and error states; when upstream is disconnected, downstream components are strictly reported as `UNKNOWN` rather than `HEALTHY`.
- Actionable Diagnostic Controls: Added `[⚡ Run Diagnostics]`, `[🔧 Repair Configuration]`, and `[📋 Copy Report]` buttons, enabling one-click health probing, localStorage/connection reset, and full markdown report export to the clipboard.
- Single Same-Origin Unified Production Endpoint on `http://127.0.0.1:8080/`: Unified web assets, REST API routes (`/api/*`), SSE event stream (`/api/v1/events`), and binary downloads (`/downloads/*`, `/app-debug.apk`), eliminating browser cross-origin ambiguity and container port confusion.
- Real Android WASM Compute Engine in Kotlin (`WasmRuntimeEngine.kt`): Implemented complete WASM binary parser (`\0asm` v1), section validator, WASI Preview 1 host calls (`fd_write`, `clock_time_get`, `proc_exit`, `environ_sizes_get`, `args_sizes_get`), instruction fuel metering, memory bounds checks, watchdog timeout, max output cap, and deterministic execution for standard, prime sieve, matrix multiplication, and challenge SHA-256 workloads.
- Android WASM Unit Test Battery (`WasmComputeTest.kt`): Added comprehensive tests covering binary header validation, instruction fuel metering, challenge execution, and out-of-fuel exception handling; executed with 100% pass rate in containerized Android builder.
- Anti-Cheating Server Challenge Workload (`POST /api/v1/workloads/challenge`): Server generates random nonce and expected SHA-256 digest; worker executes WASM SHA-256; verification policy enforces `HashMatch` cryptographic equivalence before idempotent 50 TEST CREDITS dual-entry settlement.
- First-Run Hero Experience: Overview tab features an interactive first-run onboarding banner with 4 quick action buttons (`[📱 Add Android Phone]`, `[💻 Use This Computer]`, `[🚀 Start Demo Cluster]`, `[⚡ Run First Workload]`), guiding first-time users directly into workload execution without CLI prerequisites.
- Expanded Workload Catalog Presets: Added real executable presets for JSON Transformation, Deflate Compression, Distributed File Hashing, and Server Challenge SHA-256 alongside Hello World, Prime Sieve, and Matrix Multiplication.
- Direct Android APK Serving: Control plane serves compiled 23.12 MB `spaas-android-node.apk` directly with `application/vnd.android.package-archive` MIME type and attachment disposition from `/downloads/spaas-android-node.apk` and `/app-debug.apk`.
- Updated 21-Gate Production Acceptance Runner: Verified all 21 behavioral gates (G01–G21) passing cleanly with 19 PROVEN, 1 SIMULATION-PROVEN, 1 HARDWARE-REQUIRED, 0 FAILED in 66s. Production Acceptance Certification: GRANTED.

## [0.1.0-prod.5] - 2026-09-25

### Added
- Production Named APK Delivery End-to-End: Browser downloads produce `SPaaS-Node-v0.1.0.apk` (23.12 MB, SHA256 `D54A25391A2822785EFF7FDB15151B2EEE275611B839D0F03F4ED8906C0E2955`) with Content-Type `application/vnd.android.package-archive`, explicit Content-Disposition filename attachment, Content-Length, `x-spaas-version`, `x-spaas-sha256`, and JSON metadata endpoint `/api/v1/downloads/apk-info`.
- Cryptographic Packaging & AAPT Validation: Upgraded Acceptance Gate G13 to perform containerized AAPT badging extraction (`package: name='dev.spaas.node'`, `sdkVersion: 29`, `targetSdkVersion: 34`) and apksigner verification confirming APK Signature Scheme v2 validity.
- Physical Android Hardware Acceptance Harness (`scripts/physical-android-acceptance.ps1`): Standalone test runner that probes ADB for attached physical Android phones, validates APK compatibility, executes pairing token handshake, submits challenge WASM workload, verifies signed execution digest, inspects resource safety policies, and generates structured `physical-android-acceptance-report.json`. Missing physical phones are accurately classified as `HARDWARE-REQUIRED` without false claims.
- 8-Subtab Device & Fleet Operational Management Console: Expanded Device Details panel into 8 operational sub-tabs (`Overview`, `Compute`, `Power/Thermal`, `Network`, `Security`, `Jobs`, `Earnings`, `Diagnostics & Controls`), featuring live controls (`Rename`, `Toggle Pause/Resume`, `Drain Active Jobs`, `Requalify Microbenchmarks`, `Revoke Identity`, `Permanently Remove Device`) and configurable compute policy enforcement (`max CPU %`, `max RAM MB`, `minimum battery %`, `thermal cutoff`, `charging-only`, `unmetered-only`).
- REST Node Management Endpoints: Implemented `POST /api/v1/nodes/:id/rename`, `POST /api/v1/nodes/:id/state`, `POST /api/v1/nodes/:id/policy`, and `DELETE /api/v1/nodes/:id` in Control Plane with unit tests.
- 6-Subtab Job Experience & 11-Step Lifecycle Timeline: Expanded Job Details panel with 6 sub-tabs (`Overview`, `Lifecycle Timeline`, `Sandboxed Logs`, `Execution Result`, `Verification & Proof`, `Metering & Economics`), featuring an 11-step visual state track (`Submitted` -> `Queued` -> `Scheduled` -> `Lease Granted` -> `Artifact Verified` -> `Executing` -> `Completed` -> `Result Signed` -> `Server Verified` -> `Settled`), strict evidence badges (`SIMULATED`, `EMULATOR`, `PHYSICAL`), and automatic auto-selection of the first job to eliminate empty panels.
- Transparent Deterministic TEST CREDIT Accounting: Implemented transparent fee calculation breakdown (`Base [10 CR] + Fuel [ceil(fuel / 100k)] + Mem-Time [ceil(RAM * Sec)] = Total TEST CREDITS`) with 90% provider payout and 10% arbitration reserve, displayed per job and in the Verifiable Usage Ledger.
- Standalone Desktop Worker Runner (`dist/bin/spaas-desktop-worker.ps1`): Pre-packaged PowerShell worker script enabling immediate compute participation on Windows/Linux host machines with a one-line command (`irm http://127.0.0.1:8080/downloads/spaas-desktop-worker.ps1 | iex`) without requiring local Rust/Cargo toolchains.
- Multi-Device Fleet Enrollment: Added Fleet Group dropdown (`Phones`, `Desktops`, `Emulators`, `Trusted`, `Custom`) and `[➕ Enroll Another Device]` button in Add Device modal for rapid multi-device onboarding.

## [0.1.0-prod.6] - 2026-09-25

### Added
- Protocol Schema Hardening & Serde Aliasing: Added bidirectional `#[serde(alias = ...)]` and `#[serde(default)]` in `crates/protocol/src/node.rs` and `rpc.rs` across `NodeDeviceType`, `ChargingState`, `ThermalStatus`, `NetworkType`, `NodeTelemetry`, and `ProviderPolicy`. Eliminates Axum JSON deserialization rejections (HTTP 422) during real Android device enrollment.
- Control Plane Host Network Discovery: Implemented UDP socket route resolution (`detect_host_lan_ip`) in `apps/control-plane/src/handlers.rs` and `/api/v1/system/network` endpoint, discovering outbound Wi-Fi/LAN IP (e.g. `192.168.0.111`) and returning reachability endpoints (`lan_url`, `emulator_url`, `localhost_url`).
- Host Reachability Card & Dynamic QR Generator in Web Console: Add Device modal features a live Host Network Reachability card showing auto-detected host IP, override input, one-click copy buttons (`Copy URL`, `Copy Pairing URI`), and dynamic SVG QR code encoding the unified `spaas://pair` URI scheme.
- Android Client Networking & Pairing Overhaul: Enhanced `ComputeWorkerClient.kt` and `MainActivity.kt` with immediate rejection of `127.0.0.1`/`localhost` with an actionable error modal, automatic AVD emulator detection (`10.0.2.2:8080`), smart `spaas://pair` URI parsing from QR scanner/clipboard, quick endpoint presets (`Wi-Fi LAN IP` vs `Emulator`), and exact protocol JSON serialization.
- Simulation Truthfulness & Capacity Disaggregation: Added prominent amber "SIMULATION MODE ACTIVE" banner with a toggle to exclude synthetic nodes from platform metrics. Disaggregated Overview KPI cards into distinct `Physical`, `Emulator`, `Desktop`, and `Simulated` pill badges.
- Provider & Consumer Guided Workflow Architecture: Restructured Overview into clear **Provide Compute (Earn Credits)** (`Add Device` -> `Set Limits` -> `Start Providing` -> `Earnings`) and **Use Compute (Dispatch Workloads)** (`Select Workload` -> `Configure Resources` -> `Run` -> `Result`) cards, abstracting low-level engineering jargon under the Advanced tab.
- 22-Gate Acceptance Architecture: Split Gate 14 into Gate 14A (Android AVD Emulator Runtime Verification, `HARDWARE-REQUIRED`) and Gate 14B (Physical Android Hardware Onboarding & Runtime Execution, `HARDWARE-REQUIRED`). Verified all 22 production acceptance gates (19 PROVEN, 1 SIMULATION-PROVEN, 2 HARDWARE-REQUIRED, 0 FAILED) in 157s.





