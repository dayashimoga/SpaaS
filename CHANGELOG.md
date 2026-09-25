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

