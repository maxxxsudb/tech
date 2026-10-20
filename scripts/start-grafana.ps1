param([switch]$Restart)
$ErrorActionPreference = 'Stop'
$container = 'tech-ai-grafana-test'
$baseUrl = 'http://localhost:3300/crf/dashboard'
$desktopStatus = (& docker desktop status 2>&1 | Out-String)
if ($desktopStatus -notmatch 'Status\s+running') {
    & docker desktop start --detach
    if ($LASTEXITCODE -ne 0) { throw 'Cannot start Docker Desktop' }
    $desktopStatus = (& docker desktop status 2>&1 | Out-String)
    if ($desktopStatus -match 'Status\s+stopped') {
        & docker desktop restart --detach
        if ($LASTEXITCODE -ne 0) { throw 'Cannot restart stopped Docker Desktop engine' }
    }
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if ((& docker desktop status 2>&1 | Out-String) -match 'Status\s+running') { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'Docker Desktop did not become ready' }
}
$image = & docker inspect $container --format '{{.Config.Image}}'
if ($LASTEXITCODE -ne 0 -or $image -ne 'grafana/grafana:13.2.2') { throw 'Expected the existing Grafana 13.2.2 container; no replacement or volume deletion is performed.' }
$running = & docker inspect $container --format '{{.State.Running}}'
$ports = (& docker inspect $container --format '{{json .NetworkSettings.Ports}}') | ConvertFrom-Json
if ($Restart -or ($running -eq 'true' -and -not $ports.'3000/tcp')) { & docker restart $container | Out-Null }
elseif ($running -ne 'true') { & docker start $container | Out-Null }
if ($LASTEXITCODE -ne 0) { throw 'Cannot start Grafana' }
for ($attempt = 0; $attempt -lt 45; $attempt++) {
    try {
        $health = Invoke-RestMethod -Uri ($baseUrl + '/api/health') -TimeoutSec 3
        if ($health.version -eq '13.2.2' -and $health.database -eq 'ok') { Write-Output ('Grafana 13.2.2 ready: ' + $baseUrl + '/'); return }
    } catch {}
    Start-Sleep -Seconds 1
}
throw 'Grafana 13.2.2 health check failed'
