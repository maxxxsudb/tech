param([string]$PluginPath = '')
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
if (-not $PluginPath) { $PluginPath = Join-Path $project 'protected/tech-ai-assistant-app' }
$PluginPath = (Resolve-Path -LiteralPath $PluginPath).Path
$manifest = Get-Content (Join-Path $PluginPath 'plugin.json') -Raw | ConvertFrom-Json
$stageRoot = Split-Path (Split-Path $PluginPath -Parent) -Parent
$archive = Join-Path $stageRoot ('zip/' + $manifest.id + '-' + $manifest.info.version + '-protected.zip')
if (-not (Test-Path -LiteralPath $archive)) { throw 'Run protect.cmd --grafana to verify the actual staged ZIP.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$extracted = Join-Path $stageRoot 'installed-from-zip'
[IO.Compression.ZipFile]::ExtractToDirectory($archive, $extracted)
$PluginPath = Join-Path $extracted $manifest.id
$name = 'tech-ai-grafana-protected'
function Invoke-Docker {
    param([string[]]$Arguments)
    & docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw ('Docker failed: ' + ($Arguments -join ' ')) }
}
$existing = @(& docker ps -a --format '{{.Names}}')
if ($LASTEXITCODE -ne 0) { throw 'Docker is unavailable' }
if ($existing -contains $name) { throw 'Protected test container already exists; refusing to overwrite it.' }
$running = @(& docker ps --format '{{.Image}}' | Where-Object { $_ -match '^grafana/grafana' })
if ($running.Count) { throw 'Stop the running Grafana first; this test never runs a second Grafana.' }
Invoke-Docker -Arguments @('image', 'inspect', 'grafana/grafana:13.2.2', '--format', '{{.Id}}')
$stand = Split-Path $project -Parent
$created = $false
try {
    $arguments = @('run', '-d', '--pull=never', '--name', $name, '-p', '127.0.0.1:3300:3000',
        '--tmpfs', '/var/lib/grafana:rw,uid=472,gid=0,size=128m',
        '--mount', "type=bind,source=$PluginPath,target=/var/lib/grafana/plugins/tech-ai-assistant-app,readonly",
        '--mount', "type=bind,source=$stand/dashboard-print/grafana/provisioning/dashboards,target=/etc/grafana/provisioning/dashboards,readonly",
        '--mount', "type=bind,source=$stand/dashboard-print/grafana/provisioning/datasources,target=/etc/grafana/provisioning/datasources,readonly",
        '--mount', "type=bind,source=$stand/dashboard-print/grafana/dashboards,target=/var/lib/grafana/dashboards,readonly",
        '-e', 'GF_SERVER_ROOT_URL=http://localhost:3300/crf/dashboard/', '-e', 'GF_SERVER_SERVE_FROM_SUB_PATH=true',
        '-e', 'GF_SECURITY_ADMIN_PASSWORD=admin', '-e', 'GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=tech-ai-assistant-app',
        '-e', 'GF_PLUGINS_PREINSTALL_DISABLED=true', '-e', 'GF_PLUGINS_PUBLIC_KEY_RETRIEVAL_DISABLED=true',
        '-e', 'GF_ANALYTICS_CHECK_FOR_UPDATES=false', '-e', 'GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES=false', 'grafana/grafana:13.2.2')
    Invoke-Docker -Arguments $arguments
    $created = $true
    & node -e "(async()=>{for(let i=0;i<60;i++){try{if((await fetch('http://localhost:3300/crf/dashboard/api/health',{signal:AbortSignal.timeout(2000)})).ok)return}catch{}await new Promise(r=>setTimeout(r,1000))}throw Error('Grafana startup timeout')})().catch(e=>{console.error(e);process.exit(1)})"
    if ($LASTEXITCODE -ne 0) { throw 'Grafana failed to start' }
    foreach ($case in @('verify-088.js', 'verify-090.js', 'verify-092.js')) {
        & node (Join-Path $PSScriptRoot 'run-protected-browser.cjs') $case
        if ($LASTEXITCODE -ne 0) { throw ('Protected UI regression: ' + $case) }
    }
} finally {
    if ($created) { Invoke-Docker -Arguments @('rm', '-f', '-v', $name) }
}
