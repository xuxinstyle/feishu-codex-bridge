Describe "Feishu Codex Bridge PowerShell scripts" {
    BeforeEach {
        $script:originalUserProfile = $env:USERPROFILE
        $script:originalPath = $env:Path
        $script:originalDotenvConfigPath = $env:DOTENV_CONFIG_PATH
        $script:testRoot = Join-Path $TestDrive ([guid]::NewGuid().ToString("N"))
        $script:bridgeDir = Join-Path $script:testRoot "feishu-codex-bridge"
        $script:profileDir = Join-Path $TestDrive "profile"
        $script:fakeBin = Join-Path $TestDrive "bin"

        New-Item -ItemType Directory -Force $script:bridgeDir | Out-Null
        New-Item -ItemType Directory -Force $script:profileDir | Out-Null
        New-Item -ItemType Directory -Force $script:fakeBin | Out-Null

        $env:USERPROFILE = $script:profileDir
        $env:Path = "$script:fakeBin;$script:originalPath"
    }

    AfterEach {
        $env:USERPROFILE = $script:originalUserProfile
        $env:Path = $script:originalPath
        if ($null -eq $script:originalDotenvConfigPath) {
            Remove-Item Env:DOTENV_CONFIG_PATH -ErrorAction SilentlyContinue
        } else {
            $env:DOTENV_CONFIG_PATH = $script:originalDotenvConfigPath
        }
    }

    It "starts from a standalone directory when generated config already exists" {
        Copy-Item (Join-Path $PSScriptRoot "..\start.ps1") $script:bridgeDir
        New-Item -ItemType Directory -Force (Join-Path $script:bridgeDir "node_modules") | Out-Null
        New-Item -ItemType Directory -Force (Join-Path $script:profileDir ".feishu-codex-bridge") | Out-Null
        Set-Content -Encoding utf8 `
            (Join-Path $script:profileDir ".feishu-codex-bridge\config.env") `
            "FEISHU_APP_ID=test"
        Set-Content -Encoding ascii (Join-Path $script:fakeBin "npm.cmd") "@echo npm-stub %*"

        $output = & (Join-Path $script:bridgeDir "start.ps1") *>&1 | Out-String -Width 4096

        $output | Should Match "npm-stub start"
    }

    It "does not treat an unrelated grandparent secrets directory as the repo root" {
        Copy-Item (Join-Path $PSScriptRoot "..\start.ps1") $script:bridgeDir
        New-Item -ItemType Directory -Force (Join-Path $script:bridgeDir "node_modules") | Out-Null
        New-Item -ItemType Directory -Force (Join-Path $TestDrive "secrets") | Out-Null
        New-Item -ItemType Directory -Force (Join-Path $script:profileDir ".feishu-codex-bridge") | Out-Null
        Set-Content -Encoding utf8 `
            (Join-Path $script:profileDir ".feishu-codex-bridge\config.env") `
            "FEISHU_APP_ID=test"
        Set-Content -Encoding ascii (Join-Path $script:fakeBin "npm.cmd") "@echo npm-stub %*"

        $output = & (Join-Path $script:bridgeDir "start.ps1") *>&1 | Out-String -Width 4096

        $output | Should Match ([regex]::Escape("Project : $script:bridgeDir"))
    }

    It "preserves the original nested tool layout even if the tool has a local secrets directory" {
        $repoRoot = Join-Path $script:testRoot "repo"
        $nestedBridge = Join-Path $repoRoot "tool\feishu-codex-bridge"
        New-Item -ItemType Directory -Force $nestedBridge | Out-Null
        Copy-Item (Join-Path $PSScriptRoot "..\start.ps1") $nestedBridge
        New-Item -ItemType Directory -Force (Join-Path $nestedBridge "node_modules") | Out-Null
        New-Item -ItemType Directory -Force (Join-Path $nestedBridge "secrets") | Out-Null
        New-Item -ItemType Directory -Force (Join-Path $repoRoot "secrets") | Out-Null
        New-Item -ItemType Directory -Force (Join-Path $script:profileDir ".feishu-codex-bridge") | Out-Null
        Set-Content -Encoding utf8 `
            (Join-Path $script:profileDir ".feishu-codex-bridge\config.env") `
            "FEISHU_APP_ID=test"
        Set-Content -Encoding ascii (Join-Path $script:fakeBin "npm.cmd") "@echo npm-stub %*"

        $output = & (Join-Path $nestedBridge "start.ps1") *>&1 | Out-String -Width 4096

        $output | Should Match ([regex]::Escape("Project : $repoRoot"))
    }

    It "runs setup from a standalone directory using its legacy local secrets file" {
        Copy-Item (Join-Path $PSScriptRoot "..\setup.ps1") $script:bridgeDir
        New-Item -ItemType Directory -Force (Join-Path $script:bridgeDir "node_modules") | Out-Null
        New-Item -ItemType Directory -Force (Join-Path $script:bridgeDir "secrets") | Out-Null
        @(
            "FEISHU_APP_ID=test-app-id"
            "FEISHU_APP_SECRET=test-app-secret"
            "CODEX_BIN=codex"
        ) | Set-Content -Encoding utf8 (Join-Path $script:bridgeDir "secrets\feishu_cursor_bridge.env")

        $output = & (Join-Path $script:bridgeDir "setup.ps1") *>&1 | Out-String -Width 4096

        Test-Path (Join-Path $script:profileDir ".feishu-codex-bridge\config.env") | Should Be $true
        $output | Should Match "1\. Edit .*feishu_cursor_bridge\.env"
    }

    It "creates the Codex secrets file from the legacy template in a standalone directory" {
        Copy-Item (Join-Path $PSScriptRoot "..\setup.ps1") $script:bridgeDir
        New-Item -ItemType Directory -Force (Join-Path $script:bridgeDir "node_modules") | Out-Null
        New-Item -ItemType Directory -Force (Join-Path $script:bridgeDir "secrets") | Out-Null
        @(
            "FEISHU_APP_ID=test-app-id"
            "FEISHU_APP_SECRET=test-app-secret"
            "CODEX_BIN=codex"
        ) | Set-Content -Encoding utf8 (Join-Path $script:bridgeDir "secrets\feishu_cursor_bridge.env.template")

        & (Join-Path $script:bridgeDir "setup.ps1") 2>&1 | Out-Null

        Test-Path (Join-Path $script:bridgeDir "secrets\feishu_codex_bridge.env") | Should Be $true
    }
}
