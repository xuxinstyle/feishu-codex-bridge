#Requires -Version 5.1
$ErrorActionPreference = "Stop"

if ($Host.Name -eq 'ConsoleHost') {
    try {
        chcp 65001 | Out-Null
        [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
        [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
        $OutputEncoding = [Console]::OutputEncoding
    } catch {}
}

function Resolve-RepoRoot {
    $standaloneRoot = (Resolve-Path $PSScriptRoot).Path
    $parentDir = Split-Path -Parent $standaloneRoot
    if ((Split-Path -Leaf $parentDir) -eq "tool") {
        $nestedRoot = Split-Path -Parent $parentDir
        if (Test-Path (Join-Path $nestedRoot "secrets")) {
            return $nestedRoot
        }
    }

    return $standaloneRoot
}

$RepoRoot = Resolve-RepoRoot
$ConfigPath = Join-Path $env:USERPROFILE ".feishu-codex-bridge\config.env"

if (-not (Test-Path $ConfigPath)) {
    & (Join-Path $PSScriptRoot "setup.ps1")
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if (-not (Test-Path $ConfigPath)) {
    throw "Missing generated config: $ConfigPath. Run setup.ps1 first."
}

Write-Host "=== Feishu Codex Bridge ==="
Write-Host "Project : $RepoRoot"
Write-Host "Config  : $ConfigPath"
Write-Host "Press Ctrl+C to stop."
Write-Host ""

$env:DOTENV_CONFIG_PATH = $ConfigPath
Push-Location $PSScriptRoot
try {
    if (-not (Test-Path (Join-Path $PSScriptRoot "node_modules"))) {
        npm install --omit=dev
    }
    npm start
} finally {
    Pop-Location
}
