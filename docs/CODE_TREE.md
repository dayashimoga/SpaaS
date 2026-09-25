# SPaaS Monorepo Code Tree

```
H:\SpaaS
├── .github/
│   └── workflows/
│       └── ci.yml                     # Multi-OS CI/CD, lint, test, release packaging
├── apps/
│   ├── android-node/                  # Native Android 15 Kotlin + Jetpack Compose app
│   │   ├── app/
│   │   │   ├── src/main/
│   │   │   │   ├── AndroidManifest.xml# Least-privilege Android manifest
│   │   │   │   └── java/dev/spaas/node/
│   │   │   │       ├── MainActivity.kt               # Jetpack Compose UI
│   │   │   │       ├── history/LocalJobHistory.kt    # Auditable local job store
│   │   │   │       ├── monitor/AndroidTelemetryMonitor.kt # BatteryManager, PowerManager
│   │   │   │       ├── policy/ProviderSafetyPolicy.kt # Automatic yield rules
│   │   │   │       └── service/ComputeForegroundService.kt # Foreground service
│   │   │   └── build.gradle.kts
│   │   ├── build.gradle.kts
│   │   └── settings.gradle.kts
│   ├── cli/                           # spaas Developer & Operator CLI tool
│   │   ├── src/main.rs
│   │   └── Cargo.toml
│   ├── control-plane/                 # Axum distributed edge orchestrator
│   │   ├── src/
│   │   │   ├── handlers.rs            # HTTP endpoints
│   │   │   ├── main.rs                # Daemon entrypoint
│   │   │   ├── reconciler.rs          # Autonomous recovery loop
│   │   │   ├── router.rs              # Route registry & CORS
│   │   │   └── state.rs               # In-memory shared state & audit log
│   │   └── Cargo.toml
│   ├── gateway/                       # Reverse proxy & ingress gateway
│   │   ├── src/main.rs
│   │   └── Cargo.toml
│   ├── node-simulator/                # Heterogeneous simulation lab (1-1000+ nodes)
│   │   ├── src/
│   │   │   ├── archetypes.rs          # Flagship, Midrange, Budget, Adversarial profiles
│   │   │   ├── cluster.rs             # Multi-node simulation runner
│   │   │   └── main.rs                # Simulator CLI entrypoint
│   │   └── Cargo.toml
│   ├── scheduler/                     # Standalone distributed scheduler daemon
│   │   ├── src/main.rs
│   │   └── Cargo.toml
│   └── web-console/                   # Modern responsive dashboard
│       ├── src/
│       │   ├── main.js                # Live telemetry & workload submission UI
│       │   └── style.css              # Dark mode design tokens
│       ├── index.html
│       ├── package.json
│       └── vite.config.js
├── crates/
│   ├── metering/                      # Verifiable credit ledger & idempotency
│   ├── node-agent/                    # Edge worker agent with auto-yield
│   ├── protocol/                      # Versioned specs, state machines, RPC
│   ├── scheduler-core/                # Multi-attribute scoring & eligibility
│   ├── security/                      # Ed25519, SHA-256, bearer tokens
│   ├── telemetry/                     # Metrics registry & distributed trace
│   ├── verification/                  # Single result & Byzantine quorum verification
│   └── workload-runtime/              # wasmi WASM/WASI gas-metered sandbox
├── deploy/
│   └── podman-compose.yml             # Disposable multi-service stack
├── containers/
│   ├── Containerfile.cli
│   ├── Containerfile.control-plane
│   ├── Containerfile.gateway
│   ├── Containerfile.node-simulator
│   └── Containerfile.web-console
├── scripts/
│   ├── acceptance / acceptance.ps1    # Production acceptance gate runner
│   ├── build / build.ps1              # Binary and asset builder
│   ├── clean / clean.ps1              # Temp file and container cleanup
│   ├── dev-down / dev-down.ps1        # Stack shutdown
│   ├── dev-up / dev-up.ps1            # Stack startup
│   └── test / test.ps1                # Comprehensive test runner
├── tests/
│   └── integration/                   # Integration, adversarial, resilience tests
├── docs/                              # 27 complete architectural manuals
├── Cargo.toml                         # Unified Rust workspace configuration
├── CHANGELOG.md                       # Permanent append-only changelog
├── IMPLEMENTATION.md                  # Detailed implementation matrix
└── TODO.md                            # Permanent append-only task ledger
```
