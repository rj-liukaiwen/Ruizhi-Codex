param(
    [switch]$InstallShortcut,
    [switch]$KeepInheritedApiKey,
    [switch]$ValidateOnly,
    [switch]$PrepareOnly,
    [string]$DataRootOverride,
    [int]$RemoteDebuggingPort = 0,
    [switch]$Wait
)

$ErrorActionPreference = 'Stop'

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$configPath = Join-Path $projectRoot 'config\rj-codex.json'
$configSummaryJson = & node -e "const fs=require('node:fs');const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(JSON.stringify({version:c.version,appExeName:c.windows&&c.windows.appExeName,dataRoot:c.development&&c.development.dataRoot,clearInheritedApiKey:c.development&&c.development.clearInheritedApiKey}));" $configPath
if ($LASTEXITCODE -ne 0) {
    throw "读取开发配置失败，退出码：$LASTEXITCODE"
}
$configSummary = $configSummaryJson | ConvertFrom-Json
$version = [string]$configSummary.version
$appRoot = Join-Path $projectRoot ("dist\test-app-{0}" -f $version)
$executablePath = Join-Path $appRoot ([string]$configSummary.appExeName)

if (-not (Test-Path -LiteralPath $executablePath)) {
    throw "本地开发程序不存在：$executablePath。请先运行 npm run build:windows:local。"
}

$configuredDataRoot = if ([string]::IsNullOrWhiteSpace($DataRootOverride)) {
    [string]$configSummary.dataRoot
} else {
    $DataRootOverride
}
if ([string]::IsNullOrWhiteSpace($configuredDataRoot)) {
    $configuredDataRoot = '.dev-data'
}
$dataRoot = if ([IO.Path]::IsPathRooted($configuredDataRoot)) {
    [IO.Path]::GetFullPath($configuredDataRoot)
} else {
    [IO.Path]::GetFullPath((Join-Path $projectRoot $configuredDataRoot))
}
$ruizhiHome = Join-Path $dataRoot 'ruizhi-home'
$electronUserData = Join-Path $dataRoot 'electron-user-data'

if ($ValidateOnly) {
    Write-Output 'VALIDATION_OK'
    Write-Output "开发版程序：$executablePath"
    Write-Output "开发版配置：$ruizhiHome"
    Write-Output "开发版缓存：$electronUserData"
    exit 0
}

if ($InstallShortcut) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $shortcutPath = Join-Path $desktop '锐捷Codex 本地开发.lnk'
    $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $windowsPowerShell
    $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $PSCommandPath
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.IconLocation = "$executablePath,0"
    $shortcut.Description = '启动隔离的锐捷Codex本地开发版'
    $shortcut.Save()
    Write-Output "已创建开发版快捷方式：$shortcutPath"
    exit 0
}

[IO.Directory]::CreateDirectory($ruizhiHome) | Out-Null
[IO.Directory]::CreateDirectory($electronUserData) | Out-Null

function Ensure-WindowsSandboxConfig {
    param([string]$Path)

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    if (-not (Test-Path -LiteralPath $Path)) {
        [IO.File]::WriteAllText($Path, "[windows]`r`nsandbox = `"elevated`"`r`n", $utf8NoBom)
        return
    }

    $content = [IO.File]::ReadAllText($Path)
    $windowsSection = [regex]::Match(
        $content,
        '(?ms)^(?<header>\s*\[windows\]\s*\r?\n)(?<body>.*?)(?=^\s*\[|\z)'
    )
    if (-not $windowsSection.Success) {
        $separator = if ($content.EndsWith("`n")) { "`r`n" } else { "`r`n`r`n" }
        [IO.File]::WriteAllText(
            $Path,
            $content + $separator + "[windows]`r`nsandbox = `"elevated`"`r`n",
            $utf8NoBom
        )
        return
    }

    $body = $windowsSection.Groups['body'].Value
    $sandboxSetting = [regex]::Match($body, '(?m)^\s*sandbox\s*=\s*[^\r\n]+')
    $updatedBody = if ($sandboxSetting.Success) {
        $body.Substring(0, $sandboxSetting.Index) + 'sandbox = "elevated"' + $body.Substring($sandboxSetting.Index + $sandboxSetting.Length)
    } else {
        "sandbox = `"elevated`"`r`n" + $body
    }
    $updated = $content.Substring(0, $windowsSection.Groups['body'].Index) +
        $updatedBody +
        $content.Substring($windowsSection.Groups['body'].Index + $windowsSection.Groups['body'].Length)
    if ($updated -ne $content) {
        [IO.File]::WriteAllText($Path, $updated, $utf8NoBom)
    }
}

function Remove-DeprecatedModelCatalogConfig {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    $content = [IO.File]::ReadAllText($Path)
    $updated = [regex]::Replace(
        $content,
        '(?m)^\s*model_catalog_json\s*=\s*[^\r\n]+\r?\n?',
        ''
    )
    if ($updated -ne $content) {
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [IO.File]::WriteAllText($Path, $updated, $utf8NoBom)
    }
}

function Ensure-MemoriesFeatureConfig {
    param([string]$Path)

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $content = if (Test-Path -LiteralPath $Path) { [IO.File]::ReadAllText($Path) } else { '' }
    $featuresSection = [regex]::Match(
        $content,
        '(?ms)^(?<header>\s*\[features\]\s*\r?\n)(?<body>.*?)(?=^\s*\[|\z)'
    )
    if (-not $featuresSection.Success) {
        $separator = if ($content.EndsWith("`n")) { "`r`n" } else { "`r`n`r`n" }
        [IO.File]::WriteAllText($Path, $content + $separator + "[features]`r`nmemories = true`r`n", $utf8NoBom)
        return
    }

    $body = $featuresSection.Groups['body'].Value
    $setting = [regex]::Match($body, '(?m)^\s*memories\s*=\s*[^\r\n]+')
    $updatedBody = if ($setting.Success) {
        $body.Substring(0, $setting.Index) + 'memories = true' + $body.Substring($setting.Index + $setting.Length)
    } else {
        "memories = true`r`n" + $body
    }
    $updated = $content.Substring(0, $featuresSection.Groups['body'].Index) +
        $updatedBody +
        $content.Substring($featuresSection.Groups['body'].Index + $featuresSection.Groups['body'].Length)
    if ($updated -ne $content) {
        [IO.File]::WriteAllText($Path, $updated, $utf8NoBom)
    }
}

$runtimeConfigPath = Join-Path $ruizhiHome 'config.toml'
Ensure-WindowsSandboxConfig $runtimeConfigPath
Remove-DeprecatedModelCatalogConfig $runtimeConfigPath
Ensure-MemoriesFeatureConfig $runtimeConfigPath

$sandboxBypassScript = Join-Path $projectRoot 'scripts\ensure-windows-dev-sandbox-bypass.mjs'
$appAsarPath = Join-Path $appRoot 'resources\app.asar'
& node $sandboxBypassScript $appAsarPath
if ($LASTEXITCODE -ne 0) {
    throw "Windows sandbox 启动阻断修复失败，退出码：$LASTEXITCODE"
}

if ($PrepareOnly) {
    Write-Output 'PREPARATION_OK'
    Write-Output "开发版配置：$ruizhiHome"
    exit 0
}

$env:RUIZHI_HOME = $ruizhiHome
$env:CODEX_HOME = $ruizhiHome
$env:CODEX_ELECTRON_USER_DATA_PATH = $electronUserData
$env:RUIZHI_DEVELOPMENT = '1'

if (-not $KeepInheritedApiKey -and $configSummary.clearInheritedApiKey -ne $false) {
    foreach ($name in @('RUIZHI_API_KEY', 'RUIJIE_UNIAPI_KEY', 'OPENAI_API_KEY')) {
        [Environment]::SetEnvironmentVariable($name, $null, [EnvironmentVariableTarget]::Process)
    }
}

Write-Output "开发版程序：$executablePath"
Write-Output "开发版配置：$ruizhiHome"
Write-Output "开发版缓存：$electronUserData"

$argumentList = @('--user-data-dir="{0}"' -f $electronUserData)
if ($RemoteDebuggingPort -gt 0) {
    $argumentList += "--remote-debugging-port=$RemoteDebuggingPort"
}
$process = Start-Process -FilePath $executablePath -ArgumentList $argumentList -WorkingDirectory $appRoot -PassThru
if ($Wait) {
    $process.WaitForExit()
    exit $process.ExitCode
}
