# SPaaS Local Development Workflow Guide

## 1. Zero Host Tooling Philosophy & Prerequisites

SPaaS is engineered to support both lightweight containerized development and native host toolchains without requiring fragile manual dependencies.

### Prerequisites (Native Workflow)
- **Rust Toolchain**: 1.80+ (`rustup toolchain install stable`)
- **WebAssembly Target**: `rustup target add wasm32-wasip1`
- **Node.js**: Node 20+ and npm 10+
- **PowerShell 7+** (Windows) or **Bash** (Linux/macOS)

### Prerequisites (Containerized Workflow)
- **Podman**: 4.5+ or Docker Engine 24+
- **Podman Compose** / Docker Compose v2

---

## 2. Launching Local Development Services

### Quick Start Script (`scripts/dev-up.ps1` or `scripts/dev-up.sh`)
To launch all services with auto-reloading:

```powershell
# Windows PowerShell
.\scripts\dev-up.ps1

# Linux / macOS
./scripts/dev-up.sh
```

This starts:
1. **Control Plane Daemon**: Running on `http://127.0.0.1:8080` with in-memory state and local WAL.
2. **Vite Dev Server**: Serving the web console on `http://localhost:5173` with instant hot-module replacement (HMR).
3. **Simulated Node Fleet**: Spawns 3 simulated edge devices (1 physical smartphone emulation, 1 desktop worker, 1 battery-constrained node) for immediate workload testing.

### Containerized Development
To start the entire cluster inside isolated rootless containers:
```bash
podman compose -f deploy/podman-compose.yml up --build
```

---

## 3. Building & Validating the Workspace

### Fast Workspace Check
```bash
# Verify compiler diagnostics across all workspace crates
cargo check --workspace --all-targets
```

### Formatting & Linting
```bash
# Format Rust source code
cargo fmt --all -- --check

# Enforce strict zero-warning clippy linter
cargo clippy --workspace --all-targets -- -D warnings
```

### Running the Test Suite
```bash
# Run all unit tests across all crates
cargo test --workspace

# Run integration tests specifically
cargo test -p spaas-integration-tests

# Run tests with backtrace for debugging
RUST_BACKTRACE=1 cargo test --workspace
```

---

## 4. Frontend Development (`apps/web-console`)

The web management console uses modern Vanilla JavaScript, CSS custom properties (design tokens), and Vite:

```bash
cd apps/web-console

# Install dependencies
npm install

# Start local Vite dev server
npm run dev

# Run production build and verify bundle size
npm run build
```

The production assets compile directly to `apps/web-console/dist/` and are automatically served by the control plane fallback handler.

---

## 5. Simulating Failures & Edge Cases

SPaaS includes built-in commands to simulate edge network conditions:
- **Disconnect Node**: Triggered via web console or `POST /api/v1/simulation/nodes/:id/offline`.
- **Thermal Throttle**: Triggered via `POST /api/v1/simulation/nodes/:id/throttle`.
- **Drain Battery**: Triggered via `POST /api/v1/simulation/nodes/:id/battery` to test low-power scheduling eviction.
