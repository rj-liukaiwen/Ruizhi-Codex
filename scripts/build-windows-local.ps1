$ErrorActionPreference = 'Stop'

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$env:RUIZHI_BUILD_CODEX = '0'

Push-Location $projectRoot
try {
    & node '.\scripts\build-windows.mjs'
    if ($LASTEXITCODE -ne 0) {
        throw "Windows 构建失败，退出码：$LASTEXITCODE"
    }

    & node '.\scripts\sync-windows-test.mjs'
    if ($LASTEXITCODE -ne 0) {
        throw "开发版隔离同步失败，退出码：$LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

Write-Output '本地开发版构建完成。运行 npm run start:windows-dev 查看效果。'
