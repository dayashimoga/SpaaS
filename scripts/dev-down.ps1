# SPaaS Development Down Script (PowerShell)
Write-Host ">>> Stopping SPaaS Environment..." -ForegroundColor Yellow

# Stop containers if running
podman compose -f deploy/podman-compose.yml down --remove-orphans 2>$null

# Stop any local cargo processes
Get-Process -Name "spaas-control-plane", "spaas-gateway", "spaas-node-simulator", "spaas-scheduler-daemon" -ErrorAction SilentlyContinue | Stop-Process -Force

Write-Host ">>> SPaaS Environment stopped successfully." -ForegroundColor Green
