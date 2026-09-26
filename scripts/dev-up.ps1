# SPaaS Development Up Script (PowerShell)
param (
    [switch]$Containerized,
    [switch]$NoBrowser,
    [switch]$Build
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($Containerized) {
    Write-Host ">>> Starting via Podman Compose..." -ForegroundColor Green
    podman compose -f deploy/podman-compose.yml up -d --build
} else {
    $startLocalScript = Join-Path $ScriptDir "start-local.ps1"
    & $startLocalScript -NoBrowser:$NoBrowser -Build:$Build
}
