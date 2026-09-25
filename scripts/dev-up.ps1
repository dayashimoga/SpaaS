# SPaaS Development Up Script (PowerShell)
param (
    [switch]$Containerized
)

Write-Host ">>> Starting SPaaS Universal Edge Compute Fabric..." -ForegroundColor Cyan

if ($Containerized) {
    Write-Host ">>> Starting via Podman Compose..." -ForegroundColor Green
    podman compose -f deploy/podman-compose.yml up -d --build
} else {
    Write-Host ">>> Starting local services..." -ForegroundColor Green
    Start-Process -FilePath "cargo" -ArgumentList "run", "-p", "spaas-control-plane" -NoNewWindow
    Start-Process -FilePath "cargo" -ArgumentList "run", "-p", "spaas-gateway" -NoNewWindow
    Start-Process -FilePath "cargo" -ArgumentList "run", "-p", "spaas-node-simulator", "--", "--nodes", "10" -NoNewWindow
}

Write-Host ">>> SPaaS Control Plane: http://localhost:8080" -ForegroundColor Yellow
Write-Host ">>> SPaaS Ingress Gateway: http://localhost:8000" -ForegroundColor Yellow
Write-Host ">>> SPaaS Web Console:    http://localhost:3000" -ForegroundColor Yellow
