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
Write-Host ">>> Initializing secure edge route..." -ForegroundColor DarkGray

$TunnelLog = Join-Path $env:TEMP "spaas_cloudflared_tunnel.log"
if (Test-Path $TunnelLog) { Remove-Item $TunnelLog -Force }

$proc = Start-Process -FilePath $cloudflaredExe `
    -ArgumentList "tunnel", "--url", "http://127.0.0.1:$LocalPort" `
    -RedirectStandardError $TunnelLog `
    -PassThru `
    -NoNewWindow

$tunnelUrl = $null
$maxWaitSec = 20
$startTime = Get-Date

while (($null -eq $tunnelUrl) -and ((Get-Date) - $startTime).TotalSeconds -lt $maxWaitSec) {
    Start-Sleep -Milliseconds 800
    if (Test-Path $TunnelLog) {
        $content = Get-Content $TunnelLog -Raw -ErrorAction SilentlyContinue
        if ($content -match 'https://[a-zA-Z0-9-]+\.trycloudflare\.com') {
            $tunnelUrl = $matches[0]
        }
    }
    if ($proc.HasExited) {
        Write-Error "cloudflared exited unexpectedly with code $($proc.ExitCode). Check $TunnelLog"
        exit 1
    }
}

if ($tunnelUrl) {
    try { Set-Clipboard -Value $tunnelUrl } catch {}

    $PagesConsoleUrl = "https://e3f684e4.spaas-console.pages.dev"
    $DirectConsoleUrl = "$PagesConsoleUrl/?api=$tunnelUrl"

    Write-Host "`n=====================================================================" -ForegroundColor Green
    Write-Host "  PUBLIC SECURE INGRESS TUNNEL ONLINE!" -ForegroundColor Green
    Write-Host "=====================================================================" -ForegroundColor Green
    Write-Host "  Public HTTPS Endpoint:  $tunnelUrl" -ForegroundColor Cyan
    Write-Host "  Direct Web Console URL: $DirectConsoleUrl" -ForegroundColor Yellow
    Write-Host "  (Copied to clipboard!)" -ForegroundColor DarkGray
    Write-Host "=====================================================================" -ForegroundColor Green
    Write-Host "`n  For Android Smartphone Pairing:" -ForegroundColor White
    Write-Host "  Enter Server URL: $tunnelUrl" -ForegroundColor Cyan
    Write-Host "  (Supports 4G/5G Cellular, Wi-Fi, CGNAT, and Guest Networks)" -ForegroundColor DarkGray
    Write-Host "---------------------------------------------------------------------" -ForegroundColor DarkGray
    Write-Host "  Opening Cloudflare Pages Console in default browser..." -ForegroundColor Green

    Start-Process $DirectConsoleUrl

    Write-Host "`n>>> Tunnel is active and proxying traffic to http://127.0.0.1:$LocalPort." -ForegroundColor Green
    Write-Host ">>> Press Ctrl+C at any time to stop the tunnel." -ForegroundColor DarkGray

    try {
        $proc.WaitForExit()
    } finally {
        if (-not $proc.HasExited) {
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        }
    }
} else {
    Write-Warning "Timed out waiting for trycloudflare.com URL. Outputting log:"
    Get-Content $TunnelLog | Select-Object -Last 20
    $proc.Kill()
}
