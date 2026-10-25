param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$appDir = Join-Path $PSScriptRoot 'seedance-ugc-studio'
$runtimeDir = Join-Path $appDir '.runtime'
$serverFile = Join-Path $appDir 'server.js'
$pidFile = Join-Path $runtimeDir 'local-server.json'
$port = 4173
$envFile = Join-Path $appDir '.env'
if (Test-Path -LiteralPath $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
        if ($line -match '^\s*PORT\s*=\s*(\d+)\s*$') { $port = [int]$Matches[1] }
    }
}
$url = "http://127.0.0.1:$port"
$env:HOST = '127.0.0.1'
$env:PORT = "$port"
function Test-AppHealth {
    try {
        $health = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 2
        return ($health.ok -eq $true -and $null -ne $health.providers)
    } catch { return $false }
}
if (Test-Path -LiteralPath $pidFile) {
    $record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    $running = Get-Process -Id ([int]$record.processId) -ErrorAction SilentlyContinue
    if ($running) {
        if ($running.Path -ne $record.executablePath -or $running.StartTime.ToUniversalTime().Ticks.ToString() -ne $record.startTimeUtcTicks) {
            throw 'The recorded PID belongs to another process. No process was changed.'
        }
        if (Test-AppHealth) {
            Write-Output "Seedance UGC Studio is already running: $url"
            if (-not $NoBrowser) { Start-Process $url }
            exit 0
        }
        throw "The recorded server is running but is not healthy. Run stop-local.ps1 first."
    }
    Remove-Item -LiteralPath $pidFile
}
if (Test-AppHealth) { throw "Port $port already serves an untracked app. Stop it or change PORT in .env." }
if (-not (Test-Path -LiteralPath (Join-Path $appDir 'node_modules/sharp'))) {
    throw 'Dependencies are missing. Run npm ci in seedance-ugc-studio first.'
}
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$process = Start-Process -FilePath $nodePath -ArgumentList ('"' + $serverFile + '"') -WorkingDirectory $appDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeDir 'server.stdout.log') -RedirectStandardError (Join-Path $runtimeDir 'server.stderr.log')
@{
    processId = $process.Id
    executablePath = $nodePath
    startTimeUtcTicks = $process.StartTime.ToUniversalTime().Ticks.ToString()
} | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding ascii
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if (Test-AppHealth) {
        Write-Output "Seedance UGC Studio started: $url"
        if (-not $NoBrowser) { Start-Process $url }
        exit 0
    }
    $process.Refresh()
    if ($process.HasExited) {
        Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
        throw "Server exited. See $runtimeDir\server.stderr.log"
    }
    Start-Sleep -Milliseconds 300
}
throw "Startup timed out. See $runtimeDir\server.stderr.log"
