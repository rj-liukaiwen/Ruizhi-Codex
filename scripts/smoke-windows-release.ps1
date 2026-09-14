$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Startup check is restricted to a disposable GitHub-hosted runner' }
$config = Get-Content -LiteralPath 'config/rj-codex.json' -Raw | ConvertFrom-Json
$appRoot = [IO.Path]::GetFullPath((Join-Path (Get-Location) '.work/windows-app-out'))
$exe = Join-Path $appRoot $config.windows.appExeName
if (-not (Test-Path -LiteralPath $exe)) { throw 'Packaged executable is missing' }
$fixture = Join-Path $env:RUNNER_TEMP ('ruizhi-startup-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$env:GH_TOKEN = $null
$env:RUIZHI_HOME = Join-Path $fixture 'home'
$env:CODEX_HOME = $env:RUIZHI_HOME
$env:CODEX_ELECTRON_USER_DATA_PATH = Join-Path $fixture 'profile'
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
try {
  $process = Start-Process -FilePath $exe -ArgumentList @("--remote-debugging-port=$port", '--no-first-run') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $fixture 'stdout.log') -RedirectStandardError (Join-Path $fixture 'stderr.log')
  $ready = $false
  for ($i=0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 1
    try {
      $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 2
      if (@($targets | Where-Object { $_.type -eq 'page' }).Count -gt 0) { $ready=$true; break }
    } catch {}
  }
  if (-not $ready) { throw 'Packaged app did not expose a browser page within the startup deadline' }
  [ordered]@{ version=$config.version; startup='passed'; check='Native packaged app exposed a browser page'; accountAuthorization='not tested' } | ConvertTo-Json | Set-Content -LiteralPath 'dist/startup-report.json' -Encoding utf8
} finally {
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($appRoot + '\', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
