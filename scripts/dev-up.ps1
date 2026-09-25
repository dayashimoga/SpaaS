# SPaaS Development Up Script (PowerShell)
param (
    [switch]$Containerized
)

Write-Host ">>> Starting SPaaS Universal Edge Compute Fabric..." -ForegroundColor Cyan

if ($Containerized) {
    Write-Host ">>> Starting via Podman Compose..." -ForegroundColor Green
    podman compose -f deploy/podman-compose.yml up -d --build
} else {
    Write-Host ">>> Starting local services (Control Plane, Gateway, Desktop Worker, 3 Simulated Nodes)..." -ForegroundColor Green
    Start-Process -FilePath "cargo" -ArgumentList "run", "-p", "spaas-control-plane" -NoNewWindow
    Start-Process -FilePath "cargo" -ArgumentList "run", "-p", "spaas-gateway" -NoNewWindow
    Start-Sleep -Seconds 3
    Start-Process -FilePath "cargo" -ArgumentList "run", "-p", "spaas-cli", "--", "node", "worker", "--name", "Desktop-Host-Worker-01", "--duration-secs", "0" -NoNewWindow
    Start-Process -FilePath "cargo" -ArgumentList "run", "-p", "spaas-node-simulator", "--", "--nodes", "3", "--duration-secs", "0" -NoNewWindow
}

Write-Host ">>> SPaaS Control Plane: http://localhost:8080" -ForegroundColor Yellow
Write-Host ">>> SPaaS Ingress Gateway: http://localhost:8000" -ForegroundColor Yellow
Write-Host ">>> SPaaS Web Console:    http://localhost:8080 (also on http://localhost:4173 or 3000 if preview server is running)" -ForegroundColor Yellow
