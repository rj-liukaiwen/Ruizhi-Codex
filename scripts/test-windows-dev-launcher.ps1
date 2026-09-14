$ErrorActionPreference = 'Stop'

$launcherPath = Join-Path $PSScriptRoot 'start-windows-dev.ps1'
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$output = & $windowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $launcherPath -ValidateOnly 2>&1
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
    throw "Windows PowerShell 5 启动器检查失败（退出码 $exitCode）：`n$($output -join "`n")"
}

if ($output -notcontains 'VALIDATION_OK') {
    throw "Windows PowerShell 5 启动器没有返回 VALIDATION_OK：`n$($output -join "`n")"
}

$testDataRoot = Join-Path ([IO.Path]::GetTempPath()) ("ruizhi-dev-launcher-{0}" -f [guid]::NewGuid().ToString('N'))
try {
    $testRuizhiHome = Join-Path $testDataRoot 'ruizhi-home'
    New-Item -ItemType Directory -Force -Path $testRuizhiHome | Out-Null
    [IO.File]::WriteAllText(
        (Join-Path $testRuizhiHome 'config.toml'),
        "model_catalog_json = `"C:\stale\models_cache.json`"`r`n`r`n[features]`r`nplugins = true`r`n",
        (New-Object System.Text.UTF8Encoding($false))
    )
    $prepareOutput = & $windowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $launcherPath -DataRootOverride $testDataRoot -PrepareOnly 2>&1
    $prepareExitCode = $LASTEXITCODE
    if ($prepareExitCode -ne 0) {
        throw "Windows PowerShell 5 启动准备失败（退出码 $prepareExitCode）：`n$($prepareOutput -join "`n")"
    }
    if ($prepareOutput -notcontains 'PREPARATION_OK') {
        throw "Windows PowerShell 5 启动准备没有返回 PREPARATION_OK：`n$($prepareOutput -join "`n")"
    }

    $generatedConfig = Join-Path $testDataRoot 'ruizhi-home\config.toml'
    $generatedContent = Get-Content -LiteralPath $generatedConfig -Raw
    if ($generatedContent -notmatch '(?ms)^\[windows\]\s*\r?\nsandbox\s*=\s*"elevated"') {
        throw "开发配置未写入 Windows sandbox 初始化状态：$generatedConfig"
    }
    if ($generatedContent -match '(?m)^\s*model_catalog_json\s*=') {
        throw "开发配置仍包含会被动态模型缓存覆盖的 model_catalog_json：$generatedConfig"
    }
    if ($generatedContent -notmatch '(?ms)^\[features\]\s*\r?\n(?:(?!^\s*\[).)*^memories\s*=\s*true\s*$') {
        throw "开发配置未启用记忆功能：$generatedConfig"
    }

    $projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $configPath = Join-Path $projectRoot 'config\rj-codex.json'
    $version = & node -e "const fs=require('node:fs');const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(c.version);" $configPath
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($version)) {
        throw "无法读取开发运行时版本：$configPath"
    }
    $appAsarPath = Join-Path $projectRoot ("dist\test-app-{0}\resources\app.asar" -f $version)
    $bypassCheck = & node (Join-Path $PSScriptRoot 'ensure-windows-dev-sandbox-bypass.mjs') --check $appAsarPath 2>&1
    if ($LASTEXITCODE -ne 0 -or $bypassCheck -notcontains 'WINDOWS_DEV_SANDBOX_BYPASS_OK') {
        throw "开发运行时仍会触发 Windows 设置阻断页：`n$($bypassCheck -join "`n")"
    }
} finally {
    if (Test-Path -LiteralPath $testDataRoot) {
        Remove-Item -LiteralPath $testDataRoot -Recurse -Force
    }
}

Write-Output 'WINDOWS_DEV_LAUNCHER_TEST_OK'
