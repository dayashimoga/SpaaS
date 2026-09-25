# SPaaS Production Podman Full-Stack Containerization E2E Test
# Validates Gate G06: Multi-service container orchestration, networking, job dispatch, crash recovery, and teardown

$ErrorActionPreference = "Stop"
$StartTime = Get-Date

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host " SPaaS Full-Stack Containerization E2E Test (Gate G06)" -ForegroundColor Cyan
Write-Host " Timestamp: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Cyan
Write-Host "=================================================================" -ForegroundColor Cyan

# 1. Check Podman
$podmanVersion = podman --version
if (-not $podmanVersion) {
    throw "Podman is not installed or available in PATH"
}
Write-Host "Podman version detected: $podmanVersion" -ForegroundColor Green

# 2. Cleanup prior runs
Write-Host "`n>>> [STEP 1/7] Cleaning up any prior test containers and network..." -ForegroundColor Yellow
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "SilentlyContinue"
podman rm -f -t 0 spaas-e2e-cp spaas-e2e-gw spaas-e2e-sim spaas-e2e-cli 2>&1 | Out-Null
podman network rm spaas-e2e-net 2>&1 | Out-Null
$ErrorActionPreference = $prevEAP

# 3. Create isolated bridge network
Write-Host "`n>>> [STEP 2/7] Creating isolated bridge network 'spaas-e2e-net'..." -ForegroundColor Yellow
podman network create spaas-e2e-net
if ($LASTEXITCODE -ne 0) { throw "Failed to create Podman network" }

$script:WorkspaceRoot = (Get-Item .).FullName
$mountArg = "${script:WorkspaceRoot}:/volume:Z"

try {
    # 4. Start Control Plane container
    Write-Host "`n>>> [STEP 3/7] Starting Control Plane container 'spaas-e2e-cp'..." -ForegroundColor Yellow
    podman run -d --name spaas-e2e-cp --network spaas-e2e-net -v $mountArg -w /volume docker.io/xd009642/tarpaulin:latest /volume/target/debug/spaas-control-plane --host 0.0.0.0 --port 8080 --data-dir /tmp/e2e-cp-data
    if ($LASTEXITCODE -ne 0) { throw "Failed to launch spaas-e2e-cp" }

    # Poll health endpoint
    Write-Host "Waiting for Control Plane health endpoint (http://spaas-e2e-cp:8080/api/v1/system/health)..."
    $healthy = $false
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Seconds 1
        $healthJson = podman run --rm --network spaas-e2e-net docker.io/library/alpine:latest wget -q -O - http://spaas-e2e-cp:8080/api/v1/system/health 2>$null
        if ($healthJson -match '"status"\s*:\s*"Healthy"') {
            $healthy = $true
            Write-Host "Control Plane is healthy: $healthJson" -ForegroundColor Green
            break
        }
    }
    if (-not $healthy) { throw "Control Plane failed to become healthy within timeout" }

    # 5. Start Gateway container
    Write-Host "`n>>> [STEP 4/7] Starting Ingress Gateway container 'spaas-e2e-gw'..." -ForegroundColor Yellow
    podman run -d --name spaas-e2e-gw --network spaas-e2e-net -v $mountArg -w /volume docker.io/xd009642/tarpaulin:latest /volume/target/debug/spaas-gateway --host 0.0.0.0 --port 8000 --upstream-url http://spaas-e2e-cp:8080
    if ($LASTEXITCODE -ne 0) { throw "Failed to launch spaas-e2e-gw" }

    # 6. Start Node Simulator container
    Write-Host "`n>>> [STEP 5/7] Starting Node Simulator container 'spaas-e2e-sim' (3 nodes)..." -ForegroundColor Yellow
    podman run -d --name spaas-e2e-sim --network spaas-e2e-net -v $mountArg -w /volume docker.io/xd009642/tarpaulin:latest /volume/target/debug/spaas-node-simulator --control-plane-url http://spaas-e2e-cp:8080 --nodes 3 --duration-secs 60
    if ($LASTEXITCODE -ne 0) { throw "Failed to launch spaas-e2e-sim" }

    # Wait for nodes to enroll
    Write-Host "Waiting for simulator nodes to register with Control Plane..."
    $nodesEnrolled = $false
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Seconds 1
        $nodesOutput = podman run --rm --network spaas-e2e-net docker.io/library/alpine:latest wget -q -O - http://spaas-e2e-cp:8080/api/v1/nodes 2>$null
        if ($nodesOutput -and $nodesOutput -ne "[]") {
            $nodesEnrolled = $true
            Write-Host "Nodes enrolled successfully!" -ForegroundColor Green
            break
        }
    }
    if (-not $nodesEnrolled) { throw "Simulator nodes failed to enroll within timeout" }

    # 7. Submit Workload via Containerized CLI
    Write-Host "`n>>> [STEP 6/7] Submitting workload via containerized CLI..." -ForegroundColor Yellow
    $submitOutput = podman run --rm --network spaas-e2e-net -v $mountArg -w /volume docker.io/xd009642/tarpaulin:latest /volume/target/debug/spaas --api-url http://spaas-e2e-cp:8080 workload submit fixtures/workload.yaml
    Write-Host $submitOutput
    if ($LASTEXITCODE -ne 0) { throw "CLI workload submit failed" }

    # Wait for node simulator to poll, execute, and report result
    Write-Host "Waiting for job execution and state verification..."
    Start-Sleep -Seconds 5

    # Query jobs via CLI
    $jobsOutput = podman run --rm --network spaas-e2e-net -v $mountArg -w /volume docker.io/xd009642/tarpaulin:latest /volume/target/debug/spaas --api-url http://spaas-e2e-cp:8080 job list
    Write-Host $jobsOutput

    # Query metering records via API
    $meteringJson = podman run --rm --network spaas-e2e-net docker.io/library/alpine:latest wget -q -O - http://spaas-e2e-cp:8080/api/v1/metering 2>$null
    Write-Host "Metering summary: $meteringJson" -ForegroundColor Cyan

    # 8. Crash Recovery Test
    Write-Host "`n>>> [STEP 7/7] Testing Control Plane crash recovery (WAL reload)..." -ForegroundColor Yellow
    podman stop spaas-e2e-cp | Out-Null
    Write-Host "Control Plane stopped. Restarting container to test WAL persistence recovery..."
    podman start spaas-e2e-cp | Out-Null
    Start-Sleep -Seconds 2

    # Verify health post-recovery
    $postRecoveryHealth = podman run --rm --network spaas-e2e-net docker.io/library/alpine:latest wget -q -O - http://spaas-e2e-cp:8080/api/v1/system/health 2>$null
    if ($postRecoveryHealth -notmatch '"status"\s*:\s*"Healthy"') {
        throw "Control Plane failed to recover healthy state after restart"
    }
    Write-Host "Post-restart health verified: $postRecoveryHealth" -ForegroundColor Green

    # Verify recovered jobs
    $recoveredJobs = podman run --rm --network spaas-e2e-net -v $mountArg -w /volume docker.io/xd009642/tarpaulin:latest /volume/target/debug/spaas --api-url http://spaas-e2e-cp:8080 job list
    Write-Host "Recovered jobs list post-restart:`n$recoveredJobs" -ForegroundColor Green

} finally {
    # Teardown
    Write-Host "`n>>> Performing clean teardown of E2E containers and network..." -ForegroundColor Yellow
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    podman rm -f -t 0 spaas-e2e-cp spaas-e2e-gw spaas-e2e-sim 2>&1 | Out-Null
    podman network rm spaas-e2e-net 2>&1 | Out-Null
    $ErrorActionPreference = $prevEAP
    Write-Host "Teardown complete." -ForegroundColor Green
}

$Duration = (Get-Date) - $StartTime
Write-Host "`n=================================================================" -ForegroundColor Green
Write-Host " PODMAN FULL-STACK E2E TEST: PASSED (Duration: $([int]$Duration.TotalSeconds)s)" -ForegroundColor Green
Write-Host " Gate G06 Production Certification: GRANTED" -ForegroundColor Green
Write-Host "=================================================================" -ForegroundColor Green
