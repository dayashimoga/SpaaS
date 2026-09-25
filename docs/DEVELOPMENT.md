# SPaaS Development Guide

## Zero Host Installation Philosophy
SPaaS development workflows prioritize containerized isolation via Podman. You do not need to install local databases, Redis, or Android build chains directly on your workstation.

---

## 1. Local Development Workflows

### 1.1 Running with Host Tooling (Cargo & Node)
If you have Rust 1.80+ and Node 20+ installed locally:
```powershell
# Windows:
.\scripts\dev-up.ps1

# Linux / macOS:
./scripts/dev-up
```

### 1.2 Running with Podman
To launch the entire platform in disposable rootless containers:
```powershell
# Windows:
.\scripts\dev-up.ps1 -Containerized

# Linux / macOS:
./scripts/dev-up --containerized
```

---

## 2. Formatting & Linting
```bash
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
```

---

## 3. Running Tests
```bash
cargo test --workspace
```
