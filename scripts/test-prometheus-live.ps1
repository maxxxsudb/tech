$ErrorActionPreference = 'Stop'
$projectPath = Split-Path $PSScriptRoot -Parent
$container = 'tech-ai-prometheus-live'
$image = 'prom/prometheus:v3.5.0'
function Invoke-Docker {
    param([string[]]$Arguments)
    & docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw ('Docker failed: ' + ($Arguments -join ' ')) }
}
$grafana = & docker inspect tech-ai-grafana-test --format '{{json .}}' | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $grafana.Config.Image -ne 'grafana/grafana:13.0.2' -or $grafana.State.Running) { throw 'Requires the existing stopped test Grafana 13.0.2 container.' }
& docker inspect $container *> $null
if ($LASTEXITCODE -eq 0) { throw 'Temporary container already exists; refusing to overwrite it.' }
& docker image inspect $image *> $null
$existingImage = $LASTEXITCODE -eq 0
$created = $false
try {
    if (-not $existingImage) { Invoke-Docker -Arguments @('pull', $image) }
    Invoke-Docker -Arguments @('start', 'tech-ai-grafana-test')
    Invoke-Docker -Arguments @('cp', (Join-Path $projectPath 'test/fixtures/prometheus-exporter.js'), 'tech-ai-grafana-test:/tmp/tech-prometheus-exporter.js')
    Invoke-Docker -Arguments @('exec', '-d', 'tech-ai-grafana-test', 'node', '/tmp/tech-prometheus-exporter.js')
    $configPath = Join-Path $projectPath 'test/fixtures/prometheus.yml'
    Invoke-Docker -Arguments @('run', '-d', '--name', $container, '--network', 'tech-ai-test', '--mount', "type=bind,source=$configPath,target=/etc/prometheus/prometheus.yml,readonly", '--tmpfs', '/prometheus:rw,uid=65534,gid=65534,size=64m', $image, '--config.file=/etc/prometheus/prometheus.yml', '--storage.tsdb.path=/prometheus', '--storage.tsdb.retention.time=1h')
    $created = $true
    & (Join-Path $PSScriptRoot 'test-grafana.ps1') -Cases verify-prometheus-schema-live.js
} finally {
    if ($created) { Invoke-Docker -Arguments @('rm', '-f', $container) }
    & docker exec -u 0 tech-ai-grafana-test rm -f /tmp/tech-prometheus-exporter.js
    Invoke-Docker -Arguments @('stop', 'tech-ai-grafana-test')
    if (-not $existingImage) { Invoke-Docker -Arguments @('image', 'rm', $image) }
}
