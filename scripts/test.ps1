# SPaaS Comprehensive Test Script (PowerShell)
param (
    [switch]$Containerized,
    [switch]$Podman
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " Running SPaaS Comprehensive Test Suite" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$usePodman = $Containerized -or $Podman
if (-not $usePodman) {
    $hasCargo = Get-Command cargo -ErrorAction SilentlyContinue
    if (-not $hasCargo) {
        Write-Host ">>> Local 'cargo' not detected. Auto-switching to Podman container execution..." -ForegroundColor Yellow
        $usePodman = $true
    }
}

if ($usePodman) {
    Write-Host ">>> Executing tests via Podman container technology (Zero host installs)..." -ForegroundColor Green
    
    # 1. Cloudflare Control Plane 29-test suite in Node container
    Write-Host "`n>>> [1/3] Running Cloudflare Control Plane Tests (Node 20 Container)..." -ForegroundColor Yellow
    $cpMount = "${PWD}/apps/cloudflare-control-plane:/app:Z"
    podman run --rm -v $cpMount -w /app docker.io/library/node:20-slim npm test
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Control plane container tests failed!" -ForegroundColor Red
        exit 1
    }

    # 2. Rust Workspace Unit & Integration Tests in Rust Container
    Write-Host "`n>>> [2/3] Running Rust Workspace Tests (Rust 1.77 Container)..." -ForegroundColor Yellow
    $wsMount = "${PWD}:/workspace:Z"
    podman run --rm -v $wsMount -w /workspace docker.io/library/rust:1.77-slim cargo test --workspace -- --nocapture
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Rust container test suite failed!" -ForegroundColor Red
        exit 1
    }

    # 3. Web Console Container Verification
    Write-Host "`n>>> [3/3] Verifying Web Console Container Build..." -ForegroundColor Yellow
    podman build -t spaas-web-console -f containers/Containerfile.web-console .
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Web console container build failed!" -ForegroundColor Red
        exit 1
    }

} else {
    Write-Host ">>> [1/4] Running Cloudflare Control Plane Test Suite (34/34 tests)..." -ForegroundColor Yellow
    Push-Location apps/cloudflare-control-plane
    npm test
    $cpCode = $LASTEXITCODE
    Pop-Location
    if ($cpCode -ne 0) {
        Write-Host "❌ Control plane test suite failed!" -ForegroundColor Red
        exit 1
    }

    Write-Host "`n>>> [2/4] Verifying Web Console Production Build..." -ForegroundColor Yellow
    Push-Location apps/web-console
    npm run build
    $webCode = $LASTEXITCODE
    Pop-Location
    if ($webCode -ne 0) {
        Write-Host "❌ Web console build failed!" -ForegroundColor Red
        exit 1
    }

    Write-Host "`n>>> [3/4] Running Rust Workspace Unit & Integration Tests..." -ForegroundColor Yellow
    cargo test --workspace -- --nocapture
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Test suite failed!" -ForegroundColor Red
        exit 1
    }

    Write-Host "`n>>> [4/4] Running Security & Adversarial Tests..." -ForegroundColor Yellow
    cargo test -p spaas-integration-tests --test adversarial_security -- --nocapture
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Security adversarial tests failed!" -ForegroundColor Red
        exit 1
    }
}

Write-Host "`n==========================================================" -ForegroundColor Green
Write-Host " All Tests Passed Successfully (100% Pass Rate)" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
