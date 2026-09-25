# SPaaS Build Script (PowerShell)
$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " Building SPaaS Release Artifacts" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Build Rust Release Binaries
Write-Host ">>> [1/3] Building Rust Release Binaries..." -ForegroundColor Yellow
cargo build --release -p spaas-cli -p spaas-control-plane -p spaas-gateway -p spaas-node-simulator -p spaas-scheduler-daemon

# 2. Build Web Console
Write-Host ">>> [2/3] Building Web Management Console Production Bundle..." -ForegroundColor Yellow
Push-Location apps/web-console
npm run build
Pop-Location

# 3. Assemble Release Directory
Write-Host ">>> [3/3] Packaging Artifacts to dist/..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path "dist/bin" | Out-Null
Copy-Item "target/release/spaas.exe" -Destination "dist/bin/" -ErrorAction SilentlyContinue
Copy-Item "target/release/spaas-control-plane.exe" -Destination "dist/bin/" -ErrorAction SilentlyContinue
Copy-Item "target/release/spaas-gateway.exe" -Destination "dist/bin/" -ErrorAction SilentlyContinue
Copy-Item "target/release/spaas-node-simulator.exe" -Destination "dist/bin/" -ErrorAction SilentlyContinue
Copy-Item "apps/android-node/app/build/outputs/apk/debug/app-debug.apk" -Destination "dist/bin/spaas-android-node.apk" -ErrorAction SilentlyContinue

Write-Host "==========================================================" -ForegroundColor Green
Write-Host " Build Completed Successfully! Artifacts in dist/" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
