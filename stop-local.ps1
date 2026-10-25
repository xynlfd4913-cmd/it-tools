$ErrorActionPreference = 'Stop'
$appDir = Join-Path $PSScriptRoot 'seedance-ugc-studio'
$pidFile = Join-Path $appDir '.runtime/local-server.json'
if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Output 'No locally managed server is running.'
    exit 0
}
$record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
$serverPid = [int]$record.processId
$running = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
if ($running) {
    if ($running.Path -ne $record.executablePath -or $running.StartTime.ToUniversalTime().Ticks.ToString() -ne $record.startTimeUtcTicks) {
        throw 'The recorded PID belongs to another process. No process was stopped.'
    }
    Stop-Process -Id $serverPid -ErrorAction Stop
    Wait-Process -Id $serverPid -Timeout 10 -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $pidFile
Write-Output 'Seedance UGC Studio stopped.'
