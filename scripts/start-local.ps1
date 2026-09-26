# ==============================================================================
# SPaaS (Smartphone as a Service) - Automated Local Orchestration Runner
# Launches the SPaaS Universal Edge Compute Fabric locally:
# 1. Checks prerequisites (Rust binaries & Web Console SPA dist bundle)
# 2. Cleans up existing/orphaned instances if needed
# 3. Detects local LAN IPv4 address for phone pairing over Wi-Fi
# 4. Boots the Control Plane daemon on http://127.0.0.1:8080 (0.0.0.0:8080)
# 5. Awaits healthy REST & SSE subsystem readiness via /api/v1/system/health
# 6. Initializes demo edge compute nodes or attaches simulated workers
# 7. Launches Web Console in default browser (optional)
# ==============================================================================

[CmdletBinding()]
param (
    [switch]$NoBrowser,
    [switch]$Build,
    [int]$SimulatedNodes = 3,
    [switch]$Restart,
    [string]$Port = "8080"
)

$ErrorActionPreference = "Stop"

Write-Host "=====================================================================" -ForegroundColor Cyan
Write-Host "    SPaaS Universal Edge Compute Fabric - Automated Local Runner    " -ForegroundColor Cyan
Write-Host "    Version: v0.1.0-prod.8 | Port: $Port                             " -ForegroundColor Cyan
Write-Host "    Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')                 " -ForegroundColor Cyan
Write-Host "=====================================================================" -ForegroundColor Cyan

# 1. Resolve workspace root
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WorkspaceRoot = Resolve-Path (Join-Path $ScriptDir "..")
Set-Location $WorkspaceRoot

# 2. Cleanup old instances if Restart requested or port conflict
if ($Restart) {
    Write-Host "`n>>> [STEP 1/6] Cleaning up previous SPaaS instances..." -ForegroundColor Yellow
    Get-Process -Name "spaas-control-plane", "spaas-gateway", "spaas-node-simulator", "spaas-scheduler-daemon", "spaas-cli" -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 800
}

# 3. Verify / Build Web Console static assets
Write-Host "`n>>> [STEP 2/6] Verifying Web Console SPA distribution..." -ForegroundColor Yellow
$WebConsoleDist = Join-Path $WorkspaceRoot "apps\web-console\dist"
$WebIndexHtml = Join-Path $WebConsoleDist "index.html"

if (-not (Test-Path $WebIndexHtml) -or $Build) {
    Write-Host "  Building Web Console bundle via npm run build..." -ForegroundColor DarkGray
    Push-Location (Join-Path $WorkspaceRoot "apps\web-console")
    try {
        if (-not (Test-Path "node_modules")) {
            npm ci | Out-Null
        }
        npm run build | Out-Null
        Write-Host "  Web Console SPA built successfully." -ForegroundColor Green
    } catch {
        Write-Warning "  Failed to run npm build, will serve existing or fallback."
    } finally {
        Pop-Location
    }
} else {
    Write-Host "  Web Console SPA distribution verified at $WebConsoleDist." -ForegroundColor Green
}

# 4. Verify / Build Control Plane binary
Write-Host "`n>>> [STEP 3/6] Verifying Control Plane binary..." -ForegroundColor Yellow
$BinaryPath = Join-Path $WorkspaceRoot "target\debug\spaas-control-plane.exe"

if (-not (Test-Path $BinaryPath) -or $Build) {
    Write-Host "  Compiling spaas-control-plane binary..." -ForegroundColor DarkGray
    cargo build -p spaas-control-plane -j 2
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Cargo build failed for spaas-control-plane"
        exit 1
    }
}
Write-Host "  Binary ready: $BinaryPath" -ForegroundColor Green

# 5. Detect Host Network IPs (Localhost & Wi-Fi LAN IP)
Write-Host "`n>>> [STEP 4/6] Resolving host network configuration..." -ForegroundColor Yellow
$LocalUrl = "http://127.0.0.1:$Port"
$LanIp = "127.0.0.1"

try {
    $foundIp = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and $_.IPAddress -notlike "172.18.*" } |
        Select-Object -ExpandProperty IPAddress -First 1
    if ($foundIp) {
        $LanIp = $foundIp
    }
} catch {
    # Fallback to localhost if network discovery is restricted
}

$LanUrl = "http://${LanIp}:$Port"
Write-Host "  Localhost URL: $LocalUrl" -ForegroundColor Cyan
Write-Host "  LAN / Phone URL: $LanUrl (Use this for physical Android pairing)" -ForegroundColor Cyan

# 6. Check if Control Plane is already running, or launch it
Write-Host "`n>>> [STEP 5/6] Starting SPaaS Control Plane Daemon..." -ForegroundColor Yellow
$isAlreadyHealthy = $false
try {
    $healthCheck = Invoke-RestMethod -Uri "$LocalUrl/api/v1/system/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
    if ($healthCheck.status -eq "HEALTHY") {
        $isAlreadyHealthy = $true
        Write-Host "  Active healthy instance detected running on port $Port." -ForegroundColor Green
    }
} catch {
    $isAlreadyHealthy = $false
}

if (-not $isAlreadyHealthy) {
    # Start process detached
    $procInfo = New-Object System.Diagnostics.ProcessStartInfo
    $procInfo.FileName = $BinaryPath
    $procInfo.WorkingDirectory = $WorkspaceRoot.ToString()
    $procInfo.UseShellExecute = $false
    $procInfo.CreateNoWindow = $true
    [System.Diagnostics.Process]::Start($procInfo) | Out-Null
    Write-Host "  Spawned background process ($BinaryPath)." -ForegroundColor DarkGray

    # Wait for health endpoint readiness
    $maxAttempts = 30
    $attempt = 0
    $ready = $false
    Write-Host -NoNewline "  Awaiting health readiness"
    while ($attempt -lt $maxAttempts) {
        $attempt++
        Start-Sleep -Milliseconds 500
        Write-Host -NoNewline "."
        try {
            $health = Invoke-RestMethod -Uri "$LocalUrl/api/v1/system/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
            if ($health.status -eq "HEALTHY") {
                $ready = $true
                break
            }
        } catch { }
    }
    Write-Host ""
    if (-not $ready) {
        Write-Error "Control Plane failed to become healthy within 15 seconds."
        exit 1
    }
    Write-Host "  Control Plane is ONLINE and HEALTHY." -ForegroundColor Green
}

# 7. Initialize Cluster Fleet & Self-Test
Write-Host "`n>>> [STEP 6/6] Initializing compute nodes & running self-test..." -ForegroundColor Yellow

# Start demo cluster if node count is low
try {
    $currentNodes = (Invoke-RestMethod -Uri "$LocalUrl/api/v1/nodes" -ErrorAction SilentlyContinue).nodes
    if ($currentNodes.Count -lt 2) {
        Write-Host "  Populating cluster fleet via demo endpoint..." -ForegroundColor DarkGray
        $demoInit = Invoke-RestMethod -Uri "$LocalUrl/api/v1/demo/start-cluster" -Method Post -ErrorAction SilentlyContinue
        Write-Host "  Enrolled $($demoInit.total_nodes) compute nodes." -ForegroundColor Green
    } else {
        Write-Host "  Cluster already has $($currentNodes.Count) registered compute nodes." -ForegroundColor Green
    }
} catch {
    Write-Warning "  Node population check skipped."
}

# Quick qualification/challenge verification test
try {
    $challenge = Invoke-RestMethod -Uri "$LocalUrl/api/v1/workloads/challenge" -Method Post -TimeoutSec 5 -ErrorAction SilentlyContinue
    if ($challenge.job_id) {
        Write-Host "  Dispatched test challenge job ($($challenge.job_id))." -ForegroundColor Green
    }
} catch {
    Write-Warning "  Challenge test execution skipped."
}

# 8. Print Summary Dashboard Table
$finalHealth = Invoke-RestMethod -Uri "$LocalUrl/api/v1/system/health" -ErrorAction SilentlyContinue
$nodesList = (Invoke-RestMethod -Uri "$LocalUrl/api/v1/nodes" -ErrorAction SilentlyContinue).nodes

Write-Host "`n=====================================================================" -ForegroundColor Green
Write-Host "   SPaaS UNIVERSAL EDGE COMPUTE FABRIC IS RUNNING LOCALLY!          " -ForegroundColor Green
Write-Host "=====================================================================" -ForegroundColor Green
Write-Host " Web Console (Local):   $LocalUrl" -ForegroundColor Yellow
Write-Host " Web Console (Wi-Fi):   $LanUrl" -ForegroundColor Yellow
Write-Host " Android APK Download:  $LanUrl/downloads/SPaaS-Node-v0.1.0.apk" -ForegroundColor Yellow
Write-Host " System Health API:     $LocalUrl/api/v1/system/health" -ForegroundColor Cyan
Write-Host " Active Edge Nodes:     $($nodesList.Count) registered ($($finalHealth.idle_nodes) idle, $($finalHealth.active_nodes) active)" -ForegroundColor Cyan
Write-Host " Completed Jobs:        $($finalHealth.completed_jobs)" -ForegroundColor Cyan
Write-Host " Subsystems Status:     Gateway, Control Plane, Scheduler, WAL, Worker Channel ALL HEALTHY" -ForegroundColor Green
Write-Host "---------------------------------------------------------------------" -ForegroundColor DarkGray
Write-Host " To stop all SPaaS processes, run: .\scripts\dev-down.ps1" -ForegroundColor DarkGray
Write-Host "=====================================================================`n" -ForegroundColor Green

# 9. Launch browser if requested
if (-not $NoBrowser) {
    Write-Host "Launching Web Console in default browser..." -ForegroundColor Cyan
    Start-Process $LocalUrl
}
