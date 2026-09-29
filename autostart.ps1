#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("Install", "Uninstall", "Status")]
    [string]$Action = "Install",

    [switch]$StartNow
)

$ErrorActionPreference = "Stop"
$TaskName = "FeishuCodexBridge"
$RunnerPath = Join-Path $PSScriptRoot "run-background.ps1"
$ConfigPath = Join-Path $env:USERPROFILE ".feishu-codex-bridge\config.env"

function Get-BridgeTask {
    return Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Show-BridgeTaskStatus {
    $task = Get-BridgeTask
    if (-not $task) {
        Write-Host "Autostart task is not installed."
        return
    }

    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "Task       : $TaskName"
    Write-Host "State      : $($task.State)"
    Write-Host "Last run   : $($info.LastRunTime)"
    Write-Host "Last result: $($info.LastTaskResult)"
    Write-Host "Next run   : at the next sign-in for $([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)"
}

switch ($Action) {
    "Install" {
        if (-not (Test-Path $RunnerPath)) {
            throw "Missing background runner: $RunnerPath"
        }
        if (-not (Test-Path $ConfigPath)) {
            throw "Missing bridge config: $ConfigPath. Run setup.ps1 first."
        }

        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $powerShellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
        $arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$RunnerPath`""
        $taskAction = New-ScheduledTaskAction `
            -Execute $powerShellPath `
            -Argument $arguments `
            -WorkingDirectory $PSScriptRoot
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
        $trigger.Delay = "PT20S"
        $principal = New-ScheduledTaskPrincipal `
            -UserId $identity `
            -LogonType Interactive `
            -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries `
            -StartWhenAvailable `
            -RestartCount 10 `
            -RestartInterval (New-TimeSpan -Minutes 1) `
            -MultipleInstances IgnoreNew
        $task = New-ScheduledTask `
            -Action $taskAction `
            -Trigger $trigger `
            -Principal $principal `
            -Settings $settings `
            -Description "Starts Feishu Codex Bridge for the current user after sign-in."

        Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
        Write-Host "OK: installed autostart task -> $TaskName"
        Write-Host "Runner: $RunnerPath"
        Write-Host "Logs  : $env:USERPROFILE\.feishu-codex-bridge\logs\bridge.log"

        if ($StartNow) {
            Start-ScheduledTask -TaskName $TaskName
            Start-Sleep -Seconds 2
        }

        Show-BridgeTaskStatus
    }

    "Uninstall" {
        $task = Get-BridgeTask
        if (-not $task) {
            Write-Host "Autostart task is already absent."
            return
        }

        if ($task.State -eq "Running") {
            Stop-ScheduledTask -TaskName $TaskName
        }
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "OK: removed autostart task -> $TaskName"
    }

    "Status" {
        Show-BridgeTaskStatus
    }
}
