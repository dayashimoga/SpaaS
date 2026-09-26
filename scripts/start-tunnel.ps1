# ==============================================================================
# SPaaS (Smartphone as a Service) - Cloudflare Tunnel Launcher
# Automatically exposes the local SPaaS Control Plane over free, secure HTTPS
# 1. Checks if cloudflared is installed; downloads standalone binary if missing
# 2. Verifies local control plane is active on port 8080
# 3. Launches an instant, public HTTPS tunnel (e.g., https://xxx.trycloudflare.com)
# 4. Outputs public URL ready for Cloudflare Pages console & Android smartphones
# ==============================================================================

[CmdletBinding()]
param (
    [string]$LocalPort = "8080",
    [switch]$AutoConnectWeb
)

$ErrorActionPreference = "Stop"

Write-Host "=====================================================================" -ForegroundColor Cyan
Write-Host "    SPaaS Edge Compute Fabric - Cloudflare Ingress Tunnel Launcher   " -ForegroundColor Cyan
Write-Host "    Target: http://127.0.0.1:$LocalPort | Cloudflare Free Ingress     " -ForegroundColor Cyan
Write-Host "=====================================================================" -ForegroundColor Cyan

# 1. Check if port 8080 is listening
$portActive = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue
if (-not $portActive) {
    Write-Warning "Local SPaaS Control Plane is not detected on port $LocalPort."
    Write-Host "  Starting local control plane in background..." -ForegroundColor Yellow
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $WorkspaceRoot = Resolve-Path (Join-Path $ScriptDir "..")
    $BinPath = Join-Path $WorkspaceRoot "target\release\spaas-control-plane.exe"
    if (-not (Test-Path $BinPath)) {
        $BinPath = Join-Path $WorkspaceRoot "target\debug\spaas-control-plane.exe"
    }
    if (Test-Path $BinPath) {
        Start-Process -FilePath $BinPath -ArgumentList "--port", $LocalPort -WindowStyle Minimized
        Start-Sleep -Seconds 2
    } else {
        Write-Host "  Please start the control plane first via: cargo run -p spaas-control-plane" -ForegroundColor Yellow
    }
} else {
    Write-Host "[OK] Control Plane is actively listening on port $LocalPort." -ForegroundColor Green
}

# 2. Locate or download cloudflared
$cloudflaredCmd = Get-Command "cloudflared" -ErrorAction SilentlyContinue
$cloudflaredExe = if ($cloudflaredCmd) { $cloudflaredCmd.Source } else { $null }

if (-not $cloudflaredExe) {
    $LocalBinDir = Join-Path (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..")) "dist\bin"
    if (-not (Test-Path $LocalBinDir)) { New-Item -ItemType Directory -Path $LocalBinDir -Force | Out-Null }
    $LocalCloudflared = Join-Path $LocalBinDir "cloudflared.exe"

    if (Test-Path $LocalCloudflared) {
        $cloudflaredExe = $LocalCloudflared
    } else {
        Write-Host "`n>>> [DOWNLOAD] Downloading official Cloudflare Tunnel client (cloudflared.exe)..." -ForegroundColor Yellow
        $DownloadUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $DownloadUrl -OutFile $LocalCloudflared -UseBasicParsing
            $cloudflaredExe = $LocalCloudflared
            Write-Host "[OK] cloudflared downloaded to: $cloudflaredExe" -ForegroundColor Green
        } catch {
            Write-Error "Failed to download cloudflared. Please run: winget install Cloudflare.cloudflared"
            exit 1
        }
    }
}

Write-Host "`n>>> [TUNNEL] Starting Cloudflare Tunnel to http://127.0.0.1:$LocalPort..." -ForegroundColor Cyan
Write-Host ">>> Press Ctrl+C at any time to terminate the tunnel." -ForegroundColor DarkGray
Write-Host "---------------------------------------------------------------------" -ForegroundColor DarkGray

# Launch tunnel and stream log to extract public URL
& $cloudflaredExe tunnel --url "http://127.0.0.1:$LocalPort"
