# SPaaS Build Script (PowerShell)
param (
    [switch]$Containerized,
    [switch]$Podman
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " Building SPaaS Release Artifacts" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$usePodman = $Containerized -or $Podman
if (-not $usePodman) {
    $hasCargo = Get-Command cargo -ErrorAction SilentlyContinue
    $hasNpm = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $hasCargo -or -not $hasNpm) {
        Write-Host ">>> Local build toolchains not fully detected. Auto-switching to Podman container execution..." -ForegroundColor Yellow
        $usePodman = $true
    }
}

New-Item -ItemType Directory -Force -Path "dist/bin" | Out-Null

if ($usePodman) {
    Write-Host ">>> Building release artifacts via Podman container technology (Zero host installs)..." -ForegroundColor Green

    # 1. Build Rust Binaries inside Rust Container
    Write-Host "`n>>> [1/3] Building Rust Release Binaries in Rust Container..." -ForegroundColor Yellow
    $wsMount = "${PWD}:/workspace:Z"
    podman run --rm -v $wsMount -w /workspace docker.io/library/rust:1.77-slim cargo build --release -p spaas-cli -p spaas-control-plane -p spaas-gateway -p spaas-node-simulator -p spaas-scheduler-daemon
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Containerized Rust build failed!" -ForegroundColor Red
        exit 1
    }

    # 2. Build Web Console inside Podman Container
    Write-Host "`n>>> [2/3] Building Web Management Console Container..." -ForegroundColor Yellow
    podman build -t spaas-web-console -f containers/Containerfile.web-console .
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Containerized Web Console build failed!" -ForegroundColor Red
        exit 1
    }

    # Extract dist files from container image
    Write-Host "Extracting web bundle from container image to dist/web..."
    podman create --name spaas-web-extract spaas-web-console | Out-Null
    podman cp spaas-web-extract:/usr/share/nginx/html "dist/web"
    podman rm -f spaas-web-extract | Out-Null

    # 3. Assemble Release Directory
    Write-Host "`n>>> [3/3] Packaging Artifacts to dist/..." -ForegroundColor Yellow
    Copy-Item "target/release/spaas" -Destination "dist/bin/" -ErrorAction SilentlyContinue
    Copy-Item "target/release/spaas.exe" -Destination "dist/bin/" -ErrorAction SilentlyContinue
    Copy-Item "target/release/spaas-control-plane" -Destination "dist/bin/" -ErrorAction SilentlyContinue
    Copy-Item "target/release/spaas-control-plane.exe" -Destination "dist/bin/" -ErrorAction SilentlyContinue
    Copy-Item "target/release/spaas-gateway" -Destination "dist/bin/" -ErrorAction SilentlyContinue
    Copy-Item "target/release/spaas-gateway.exe" -Destination "dist/bin/" -ErrorAction SilentlyContinue
    Copy-Item "target/release/spaas-node-simulator" -Destination "dist/bin/" -ErrorAction SilentlyContinue
    Copy-Item "target/release/spaas-node-simulator.exe" -Destination "dist/bin/" -ErrorAction SilentlyContinue

} else {
    # 1. Build Rust Release Binaries locally
    Write-Host ">>> [1/3] Building Rust Release Binaries..." -ForegroundColor Yellow
    cargo build --release -p spaas-cli -p spaas-control-plane -p spaas-gateway -p spaas-node-simulator -p spaas-scheduler-daemon

    # 2. Build Web Console locally
    Write-Host ">>> [2/3] Building Web Management Console Production Bundle..." -ForegroundColor Yellow
    Push-Location apps/web-console
    npm run build
    Pop-Location

    # 3. Assemble Release Directory
    Write-Host ">>> [3/3] Packaging Artifacts to dist/..." -ForegroundColor Yellow
    Copy-Item "target/release/spaas.exe" -Destination "dist/bin/" -ErrorAction SilentlyContinue
    Copy-Item "target/release/spaas-control-plane.exe" -Destination "dist/bin/" -ErrorAction SilentlyContinue
    Copy-Item "target/release/spaas-gateway.exe" -Destination "dist/bin/" -ErrorAction SilentlyContinue
    Copy-Item "target/release/spaas-node-simulator.exe" -Destination "dist/bin/" -ErrorAction SilentlyContinue
}

Write-Host "==========================================================" -ForegroundColor Green
Write-Host " Build Completed Successfully! Artifacts in dist/" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
