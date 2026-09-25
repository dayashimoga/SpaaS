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
