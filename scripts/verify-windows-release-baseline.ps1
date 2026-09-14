[CmdletBinding()]
param(
    [string]$BaselineRoot = (Join-Path $env:LOCALAPPDATA 'Programs\ChatGPT'),
    [string]$CandidateRoot,
    [string[]]$AllowDifference = @(
        'resources\owl-app.ini',
        'resources\ruizhi-environment.json',
        'resources\app.asar::webview\assets\app-main-*.js',
        'resources\app.asar::webview\assets\windows-sandbox-onboarding-context-*.js'
    )
)

$ErrorActionPreference = 'Stop'

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$configPath = Join-Path $projectRoot 'config\rj-codex.json'
$configText = [IO.File]::ReadAllText($configPath, [Text.Encoding]::UTF8)
$versionMatch = [regex]::Match($configText, '"version"\s*:\s*"(?<version>[^"]+)"')
if (-not $versionMatch.Success) {
    throw "Missing version in config: $configPath"
}
$appVersion = $versionMatch.Groups['version'].Value
if ([string]::IsNullOrWhiteSpace($CandidateRoot)) {
    $CandidateRoot = Join-Path $projectRoot ("dist\test-app-{0}" -f $appVersion)
}

$BaselineRoot = [IO.Path]::GetFullPath($BaselineRoot)
$CandidateRoot = [IO.Path]::GetFullPath($CandidateRoot)
$asarCli = Join-Path $projectRoot 'node_modules\.bin\asar.cmd'
$expectedBaselineAppAsarSha256 = 'DA1A47D896AE81954D8585A9F25794CC2F83845467DF03D4896F9CBEA23C95FB'
$expectedBaselineCodexSha256 = '6C3B4794EAD4C9390DFDF781C1BD0AB17A50935D97B761728D71801441012CDE'

function Get-RelativeFileMap {
    param([string]$Root)

    $map = @{}
    Get-ChildItem -LiteralPath $Root -Recurse -Force -File | ForEach-Object {
        $relativePath = $_.FullName.Substring($Root.Length).TrimStart('\')
        $map[$relativePath] = $_
    }
    return $map
}

function Get-Sha256 {
    param([string]$Path)

    $stream = [IO.File]::OpenRead($Path)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '')
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

function Test-DifferenceAllowed {
    param([string]$Path)

    foreach ($pattern in $AllowDifference) {
        if ($Path -like $pattern.Replace('/', '\')) {
            return $true
        }
    }
    return $false
}

function Compare-FileTrees {
    param(
        [string]$Baseline,
        [string]$Candidate,
        [string]$Prefix = '',
        [string[]]$Exclude = @()
    )

    $baselineFiles = Get-RelativeFileMap $Baseline
    $candidateFiles = Get-RelativeFileMap $Candidate
    $differences = New-Object System.Collections.Generic.List[object]
    $paths = @($baselineFiles.Keys + $candidateFiles.Keys | Sort-Object -Unique)

    foreach ($relativePath in $paths) {
        if ($Exclude -contains $relativePath) {
            continue
        }

        $displayPath = $Prefix + $relativePath
        if (-not $baselineFiles.ContainsKey($relativePath)) {
            $differences.Add([PSCustomObject]@{ Path = $displayPath; Reason = 'candidate-only' })
            continue
        }
        if (-not $candidateFiles.ContainsKey($relativePath)) {
            $differences.Add([PSCustomObject]@{ Path = $displayPath; Reason = 'baseline-only' })
            continue
        }

        $baselineFile = $baselineFiles[$relativePath]
        $candidateFile = $candidateFiles[$relativePath]
        if ($baselineFile.Length -ne $candidateFile.Length) {
            $differences.Add([PSCustomObject]@{ Path = $displayPath; Reason = 'length' })
            continue
        }

        $baselineHash = Get-Sha256 $baselineFile.FullName
        $candidateHash = Get-Sha256 $candidateFile.FullName
        if ($baselineHash -ne $candidateHash) {
            $differences.Add([PSCustomObject]@{ Path = $displayPath; Reason = 'hash' })
        }
    }

    return $differences
}

foreach ($requiredRoot in @($BaselineRoot, $CandidateRoot)) {
    if (-not (Test-Path -LiteralPath $requiredRoot -PathType Container)) {
        throw "Directory does not exist: $requiredRoot"
    }
}
if (-not (Test-Path -LiteralPath $asarCli -PathType Leaf)) {
    throw "Missing asar tool: $asarCli"
}

$baselineAppAsar = Join-Path $BaselineRoot 'resources\app.asar'
$baselineCodex = Join-Path $BaselineRoot 'resources\codex.exe'
$actualBaselineAppAsarSha256 = Get-Sha256 $baselineAppAsar
$actualBaselineCodexSha256 = Get-Sha256 $baselineCodex
if ($actualBaselineAppAsarSha256 -ne $expectedBaselineAppAsarSha256) {
    throw "Release baseline app.asar changed: $actualBaselineAppAsarSha256"
}
if ($actualBaselineCodexSha256 -ne $expectedBaselineCodexSha256) {
    throw "Release baseline codex.exe changed: $actualBaselineCodexSha256"
}

Write-Output 'BASELINE_COMPARE_STARTED'
$differences = New-Object System.Collections.Generic.List[object]
$outerDifferences = Compare-FileTrees -Baseline $BaselineRoot -Candidate $CandidateRoot -Exclude @('resources\app.asar')
foreach ($difference in $outerDifferences) {
    $differences.Add($difference)
}

$candidateAppAsar = Join-Path $CandidateRoot 'resources\app.asar'
if (-not (Test-Path -LiteralPath $candidateAppAsar -PathType Leaf)) {
    $differences.Add([PSCustomObject]@{ Path = 'resources\app.asar'; Reason = 'baseline-only' })
} else {
    $candidateAppAsarSha256 = Get-Sha256 $candidateAppAsar
    if ($candidateAppAsarSha256 -ne $actualBaselineAppAsarSha256) {
        $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
        $tempRoot = Join-Path $tempBase ("ruizhi-baseline-{0}" -f [guid]::NewGuid().ToString('N'))
        $tempRoot = [IO.Path]::GetFullPath($tempRoot)
        if (-not $tempRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Temporary directory escaped its root: $tempRoot"
        }
        try {
            $baselineExtracted = Join-Path $tempRoot 'baseline'
            $candidateExtracted = Join-Path $tempRoot 'candidate'
            New-Item -ItemType Directory -Force -Path $baselineExtracted, $candidateExtracted | Out-Null
            & $asarCli extract $baselineAppAsar $baselineExtracted
            if ($LASTEXITCODE -ne 0) { throw "Failed to extract release baseline app.asar: $LASTEXITCODE" }
            & $asarCli extract $candidateAppAsar $candidateExtracted
            if ($LASTEXITCODE -ne 0) { throw "Failed to extract candidate app.asar: $LASTEXITCODE" }
            $asarDifferences = Compare-FileTrees -Baseline $baselineExtracted -Candidate $candidateExtracted -Prefix 'resources\app.asar::'
            foreach ($difference in $asarDifferences) {
                $differences.Add($difference)
            }
        } finally {
            if (Test-Path -LiteralPath $tempRoot) {
                Remove-Item -LiteralPath $tempRoot -Recurse -Force
            }
        }
    }
}

$allowed = @($differences | Where-Object { Test-DifferenceAllowed $_.Path })
$unexpected = @($differences | Where-Object { -not (Test-DifferenceAllowed $_.Path) })
[PSCustomObject]@{
    BaselineRoot = $BaselineRoot
    CandidateRoot = $CandidateRoot
    AllowedDifferences = @($allowed | Select-Object Path, Reason)
    UnexpectedDifferences = @($unexpected | Select-Object Path, Reason)
} | ConvertTo-Json -Depth 5

if ($unexpected.Count -gt 0) {
    Write-Error "Found $($unexpected.Count) unapproved release baseline differences"
    exit 1
}

Write-Output 'WINDOWS_RELEASE_BASELINE_OK'
