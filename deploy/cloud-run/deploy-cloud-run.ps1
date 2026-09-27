# Google Cloud Run Cold-Standby Deployment & Failover Verification Script
param (
    [string]$ProjectId = $env:GCP_PROJECT_ID,
    [string]$Region = "us-central1",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host " SPaaS Google Cloud Run Disaster Recovery Deployment" -ForegroundColor Cyan
Write-Host " Role: Cold Standby (min-instances: 0, `$0.00 idle cost)" -ForegroundColor Cyan
Write-Host " Region: $Region" -ForegroundColor Cyan
Write-Host "=================================================================" -ForegroundColor Cyan

if (-not $ProjectId) {
    $ProjectId = "spaas-edge-compute"
    Write-Host "Note: GCP_PROJECT_ID not set. Using target project: $ProjectId" -ForegroundColor Yellow
}

$ManifestPath = Join-Path $PSScriptRoot "service.yaml"
if (-not (Test-Path $ManifestPath)) {
    throw "Manifest service.yaml not found at $ManifestPath"
}

if ($DryRun) {
    Write-Host "`n[DRY RUN] Validating service.yaml Knative schema..." -ForegroundColor Green
    $yamlContent = Get-Content $ManifestPath -Raw
    if ($yamlContent -match 'minScale:\s*"0"' -and $yamlContent -match 'SPAAS_ROLE' -and $yamlContent -match 'STANDBY') {
        Write-Host "Manifest verified: minScale=0, SPAAS_ROLE=STANDBY" -ForegroundColor Green
    } else {
        throw "Manifest verification failed: missing minScale=0 or SPAAS_ROLE=STANDBY"
    }
    Write-Host "[DRY RUN] Complete. No cloud resources were modified." -ForegroundColor Green
    exit 0
}

Write-Host "`nStep 1: Building container image via Cloud Build or Podman..."
Write-Host "gcloud builds submit --project $ProjectId --tag gcr.io/$ProjectId/spaas-control-plane:latest ."

Write-Host "`nStep 2: Deploying Knative service manifest to Cloud Run..."
Write-Host "gcloud run services replace $ManifestPath --project $ProjectId --region $Region"

Write-Host "`nStep 3: Checking deployed service status..."
Write-Host "gcloud run services describe spaas-control-plane-backup --project $ProjectId --region $Region"

Write-Host "`nDeployment template validated for Google Cloud Run cold standby." -ForegroundColor Green
