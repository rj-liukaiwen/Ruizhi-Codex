$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Startup check is restricted to a disposable GitHub-hosted runner' }
$config = Get-Content -LiteralPath 'config/rj-codex.json' -Raw | ConvertFrom-Json -AsHashtable
$fixture = Join-Path $env:RUNNER_TEMP ('ruizhi-startup-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$archive = "dist/github-release/ruizhi-windows-$($config.version).zip"
$appRoot = Join-Path $fixture 'app'
Expand-Archive -LiteralPath $archive -DestinationPath $appRoot
$exe = Join-Path $appRoot $config.windows.appExeName
if (-not (Test-Path -LiteralPath $exe)) { throw 'Packaged executable is missing' }
$env:GH_TOKEN = $null
$env:RUIZHI_HOME = Join-Path $fixture 'home'
$env:CODEX_HOME = $env:RUIZHI_HOME
$env:CODEX_ELECTRON_USER_DATA_PATH = Join-Path $fixture 'profile'
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
try {
  $process = Start-Process -FilePath $exe -ArgumentList @("--remote-debugging-port=$port", "--user-data-dir=`"$($env:CODEX_ELECTRON_USER_DATA_PATH)`"", '--no-first-run') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $fixture 'stdout.log') -RedirectStandardError (Join-Path $fixture 'stderr.log')
  $ready = $false
  for ($i=0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 1
    try {
      $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 2
      if (@($targets | Where-Object { $_.type -eq 'page' }).Count -gt 0) { $ready=$true; break }
    } catch {}
  }
  if (-not $ready) { throw 'Packaged app did not expose a browser page within the startup deadline' }
  [ordered]@{ version=$config.version; startup='passed'; check='App extracted from release ZIP exposed a browser page'; archiveSha256=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant(); accountAuthorization='not tested' } | ConvertTo-Json | Set-Content -LiteralPath 'dist/startup-report.json' -Encoding utf8
  Copy-Item -LiteralPath 'dist/startup-report.json' -Destination 'dist/github-release/startup-report.json'
} finally {
  New-Item -ItemType Directory -Path 'dist/startup-diagnostics' -Force | Out-Null
  Get-ChildItem -LiteralPath $fixture -Filter '*.log' | Copy-Item -Destination 'dist/startup-diagnostics'
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($appRoot + '\', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
