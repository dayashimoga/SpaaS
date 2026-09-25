# SPaaS Comprehensive Test Script (PowerShell)
$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " Running SPaaS Comprehensive Test Suite" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

Write-Host ">>> [1/2] Running Unit & Integration Tests (100% Pass Target)..." -ForegroundColor Yellow
cargo test --workspace -- --nocapture
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Test suite failed!" -ForegroundColor Red
    exit 1
}

Write-Host ">>> [2/2] Running Security & Adversarial Tests..." -ForegroundColor Yellow
cargo test -p spaas-integration-tests --test adversarial_security -- --nocapture
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Security adversarial tests failed!" -ForegroundColor Red
    exit 1
}

Write-Host "==========================================================" -ForegroundColor Green
Write-Host " All Tests Passed Successfully (100% Pass Rate)" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
