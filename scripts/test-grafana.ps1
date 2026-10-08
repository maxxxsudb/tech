param(
    [string]$Container = 'tech-ai-grafana-test',
    [switch]$Prepare,
    [string[]]$Cases = @('verify-080.js', 'verify-features.js', 'verify-panel-selection.js', 'verify-investigation-tools.js', 'verify-apply.js', 'verify-ux.js')
)
$ErrorActionPreference = 'Stop'
$projectPath = Split-Path $PSScriptRoot -Parent
function Invoke-Docker {
    param([string[]]$Arguments)
    & docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw ('Docker command failed: ' + ($Arguments -join ' ')) }
}

$image = & docker inspect $Container --format '{{.Config.Image}}'
if ($LASTEXITCODE -ne 0 -or $image -ne 'grafana/grafana:13.0.2') { throw 'Reuse the existing Grafana 13.0.2 container; this script does not create containers or images.' }
Invoke-Docker -Arguments @('start', $Container)
if ($Prepare) {
    Invoke-Docker -Arguments @('exec', '-u', '0', $Container, 'apk', 'add', '--no-cache', 'nodejs', 'npm', 'chromium', 'font-dejavu', 'font-liberation')
    Invoke-Docker -Arguments @('exec', '-u', '0', '-e', 'PUPPETEER_SKIP_DOWNLOAD=true', '-e', 'npm_config_cache=/tmp/tech-npm-cache', $Container, 'npm', 'install', '--prefix', '/opt/tech-browser', '--omit=dev', '--no-audit', '--no-fund', '--package-lock=false', 'puppeteer@24.24.1')
    Invoke-Docker -Arguments @('exec', '-u', '0', '-e', 'npm_config_cache=/tmp/tech-npm-cache', $Container, 'npm', 'cache', 'clean', '--force')
}
Invoke-Docker -Arguments @('exec', '-e', 'NODE_PATH=/opt/tech-browser/node_modules', $Container, 'node', '-e', "require('puppeteer'); console.log('Puppeteer ready')")
Invoke-Docker -Arguments @('cp', (Join-Path $projectPath 'test/.'), ($Container + ':/test'))
Invoke-Docker -Arguments @('exec', '-u', '0', $Container, 'mkdir', '-p', '/test-results')
Invoke-Docker -Arguments @('exec', '-u', '0', $Container, 'chown', '-R', '472:0', '/test', '/test-results')
foreach ($case in $Cases) {
    if ($case -notmatch '^verify-[a-z0-9-]+\.js$' -or -not (Test-Path (Join-Path $projectPath ('test/' + $case)))) { throw ('Unknown test: ' + $case) }
    Invoke-Docker -Arguments @('exec', '-e', 'NODE_PATH=/opt/tech-browser/node_modules', $Container, 'node', ('/test/' + $case))
}
New-Item -ItemType Directory -Path (Join-Path $projectPath 'test-results') -Force | Out-Null
Invoke-Docker -Arguments @('cp', ($Container + ':/test-results/.'), (Join-Path $projectPath 'test-results'))
