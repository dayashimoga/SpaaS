# SPaaS Clean Script (PowerShell)
Write-Host ">>> Cleaning disposable build artifacts and temporary containers..." -ForegroundColor Yellow

# Clean containers
podman compose -f deploy/podman-compose.yml down --volumes --remove-orphans 2>$null

# Clean build artifacts
Remove-Item -Recurse -Force "target" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "dist" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "apps/web-console/dist" -ErrorAction SilentlyContinue

Write-Host ">>> Clean completed." -ForegroundColor Green
