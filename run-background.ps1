#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$StartScript = Join-Path $PSScriptRoot "start.ps1"
$LogDir = Join-Path $env:USERPROFILE ".feishu-codex-bridge\logs"
$LogPath = Join-Path $LogDir "bridge.log"
$PreviousLogPath = Join-Path $LogDir "bridge.previous.log"
$MaxLogBytes = 10MB

if (-not (Test-Path $StartScript)) {
    throw "Missing bridge start script: $StartScript"
}

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}

if ((Test-Path $LogPath) -and (Get-Item $LogPath).Length -ge $MaxLogBytes) {
    Move-Item -Force -Path $LogPath -Destination $PreviousLogPath
}

function Write-BridgeLog([string]$Message) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Encoding utf8 -Path $LogPath -Value "[$timestamp] $Message"
}

Write-BridgeLog "Starting Feishu Codex Bridge from $PSScriptRoot"

try {
    $LASTEXITCODE = 0
    & $StartScript *>&1 | ForEach-Object {
        Add-Content -Encoding utf8 -Path $LogPath -Value ([string]$_)
    }

    $exitCode = $LASTEXITCODE
    Write-BridgeLog "Bridge stopped with exit code $exitCode"
    if ($exitCode -ne 0) {
        throw "Bridge exited with code $exitCode"
    }
} catch {
    Write-BridgeLog "Bridge failed: $($_.Exception.Message)"
    throw
}
