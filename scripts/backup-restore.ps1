<#
.SYNOPSIS
    SPaaS Disaster Recovery & State Backup/Restore Utility.
.DESCRIPTION
    Provides automated backup creation, archive verification, and safe restoration
    for the SPaaS Control Plane state (WAL logs, server cryptographic keys, and snapshots).
.PARAMETER Backup
    Creates a new timestamped backup archive of the data directory.
.PARAMETER Restore
    Restores the cluster state from a specified backup archive.
.PARAMETER Verify
    Verifies the integrity and checksum of a specified backup archive.
.PARAMETER List
    Lists all available backup archives in the backup directory.
.PARAMETER DataDir
    Path to the SPaaS data directory (default: ./data/control-plane).
.PARAMETER BackupDir
    Directory where backup archives are stored (default: ./data/backups).
.EXAMPLE
    .\scripts\backup-restore.ps1 -Backup
    .\scripts\backup-restore.ps1 -List
    .\scripts\backup-restore.ps1 -Verify .\data\backups\spaas-backup-20260926-120000.zip
    .\scripts\backup-restore.ps1 -Restore .\data\backups\spaas-backup-20260926-120000.zip
#>

[CmdletBinding(DefaultParameterSetName = "Backup")]
param(
    [Parameter(ParameterSetName = "Backup")]
    [switch]$Backup,

    [Parameter(ParameterSetName = "Restore", Mandatory = $true)]
    [string]$Restore,

    [Parameter(ParameterSetName = "Verify", Mandatory = $true)]
    [string]$Verify,

    [Parameter(ParameterSetName = "List")]
    [switch]$List,

    [Parameter()]
    [string]$DataDir = "./data/control-plane",

    [Parameter()]
    [string]$BackupDir = "./data/backups"
)

$ErrorActionPreference = "Stop"

function Write-Info ($msg) {
    Write-Host "[INFO] $msg" -ForegroundColor Cyan
}

function Write-Success ($msg) {
    Write-Host "[SUCCESS] $msg" -ForegroundColor Green
}

function Write-Warn ($msg) {
    Write-Host "[WARN] $msg" -ForegroundColor Yellow
}

function Write-Err ($msg) {
    Write-Host "[ERROR] $msg" -ForegroundColor Red
}

# Resolve directories
$resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
$resolvedBackupDir = [System.IO.Path]::GetFullPath($BackupDir)

if (-not (Test-Path $resolvedBackupDir)) {
    New-Item -ItemType Directory -Path $resolvedBackupDir -Force | Out-Null
}

# 1. ACTION: LIST
if ($List) {
    Write-Info "Scanning backup archives in: $resolvedBackupDir"
    $archives = Get-ChildItem -Path $resolvedBackupDir -Filter "spaas-backup-*.zip" | Sort-Object CreationTime -Descending
    if ($archives.Count -eq 0) {
        Write-Host "No backup archives found." -ForegroundColor Gray
        exit 0
    }

    Write-Host ""
    Write-Host ("{0,-35} {1,-15} {2,-25}" -f "Archive Filename", "Size (KB)", "Created (UTC)") -ForegroundColor White
    Write-Host ("-" * 75) -ForegroundColor Gray
    foreach ($a in $archives) {
        $sizeKb = [math]::Round($a.Length / 1KB, 2)
        $createdUtc = $a.CreationTimeUtc.ToString("yyyy-MM-dd HH:mm:ss")
        Write-Host ("{0,-35} {1,-15} {2,-25}" -f $a.Name, "$sizeKb KB", $createdUtc)
    }
    Write-Host ""
    exit 0
}

# 2. ACTION: VERIFY
if ($Verify) {
    $archivePath = [System.IO.Path]::GetFullPath($Verify)
    if (-not (Test-Path $archivePath)) {
        Write-Err "Backup file not found: $archivePath"
        exit 1
    }

    Write-Info "Verifying backup archive: $archivePath"
    $sha256 = (Get-FileHash -Path $archivePath -Algorithm SHA256).Hash
    Write-Host "  Archive SHA-256: $sha256" -ForegroundColor Gray

    # Test extracting to temporary directory
    $tempDir = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "spaas-verify-" + [Guid]::NewGuid().ToString("N"))
    try {
        Expand-Archive -Path $archivePath -DestinationPath $tempDir -Force
        $files = Get-ChildItem -Path $tempDir -Recurse -File
        Write-Success "Archive integrity verified! Contains $($files.Count) valid files."
        foreach ($f in $files) {
            $rel = $f.FullName.Substring($tempDir.Length).TrimStart('\', '/')
            Write-Host "    - $rel ($([math]::Round($f.Length / 1KB, 2)) KB)" -ForegroundColor DarkGray
        }
    }
    catch {
        Write-Err "Archive corrupted or unreadable: $_"
        exit 1
    }
    finally {
        if (Test-Path $tempDir) {
            Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    exit 0
}

# 3. ACTION: RESTORE
if ($Restore) {
    $archivePath = [System.IO.Path]::GetFullPath($Restore)
    if (-not (Test-Path $archivePath)) {
        Write-Err "Backup file not found: $archivePath"
        exit 1
    }

    Write-Warn "Restoring state will overwrite active files in: $resolvedDataDir"
    
    # Create safety snapshot of current data dir if it exists
    if (Test-Path $resolvedDataDir) {
        $safetyDir = "$resolvedBackupDir/pre-restore-safety-" + (Get-Date -Format "yyyyMMdd-HHmmss")
        Write-Info "Creating pre-restore safety snapshot at: $safetyDir"
        Copy-Item -Path $resolvedDataDir -Destination $safetyDir -Recurse -Force
    }

    Write-Info "Extracting archive to target directory..."
    if (-not (Test-Path $resolvedDataDir)) {
        New-Item -ItemType Directory -Path $resolvedDataDir -Force | Out-Null
    }

    try {
        Expand-Archive -Path $archivePath -DestinationPath $resolvedDataDir -Force
        Write-Success "State successfully restored to: $resolvedDataDir"
        Write-Info "Restart the SPaaS Control Plane to reload the recovered state."
    }
    catch {
        Write-Err "Restore failed: $_"
        exit 1
    }
    exit 0
}

# 4. ACTION: BACKUP (Default)
Write-Info "Initiating cluster state backup from: $resolvedDataDir"

if (-not (Test-Path $resolvedDataDir)) {
    Write-Warn "Data directory does not exist yet. Creating empty directory..."
    New-Item -ItemType Directory -Path $resolvedDataDir -Force | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$archiveName = "spaas-backup-$timestamp.zip"
$destZip = [System.IO.Path]::Combine($resolvedBackupDir, $archiveName)

try {
    # Check if data directory has contents
    $items = Get-ChildItem -Path $resolvedDataDir
    if ($items.Count -eq 0) {
        Write-Warn "Data directory is currently empty. Writing placeholder state metadata..."
        $meta = @{
            backup_timestamp_utc = (Get-Date).ToUniversalTime().ToString("o")
            spaas_version = "0.1.0"
            status = "INITIAL_EMPTY_STATE"
        } | ConvertTo-Json
        Set-Content -Path "$resolvedDataDir/backup_meta.json" -Value $meta -Encoding UTF8
    }

    Write-Info "Compressing state into archive: $destZip"
    Compress-Archive -Path "$resolvedDataDir/*" -DestinationPath $destZip -Force

    $hash = (Get-FileHash -Path $destZip -Algorithm SHA256).Hash
    $sizeKb = [math]::Round((Get-Item $destZip).Length / 1KB, 2)

    Write-Success "Backup created successfully!"
    Write-Host "  File:    $destZip" -ForegroundColor White
    Write-Host "  Size:    $sizeKb KB" -ForegroundColor Gray
    Write-Host "  SHA-256: $hash" -ForegroundColor Gray
}
catch {
    Write-Err "Backup creation failed: $_"
    exit 1
}
