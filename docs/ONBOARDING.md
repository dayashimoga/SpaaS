# SPaaS Engineering Team Onboarding

Welcome to the SPaaS engineering team! This guide walks new contributors through their first 30 minutes in the repository.

---

## 1. Prerequisites
- **Git** 2.40+
- **Podman** 5.0+ (or Docker Engine 24+)
- Optional local tooling: **Rust** 1.80+ and **Node.js** 20+

---

## 2. Setup in 3 Commands
```bash
git clone https://github.com/spaas-edge/spaas.git
cd spaas
./scripts/acceptance
```
If all 10 acceptance gates pass, your development environment is fully verified and ready!

---

## 3. Key Subsystems by Lead
- **Distributed Systems / Scheduler**: `crates/scheduler-core/`, `apps/control-plane/`
- **Security & Cryptography**: `crates/security/`, `crates/verification/`
- **Mobile / Android**: `apps/android-node/`, `crates/node-agent/`
- **Web / Frontend**: `apps/web-console/`
