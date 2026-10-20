param(
    [string]$Container = 'tech-ai-grafana-test',
    [switch]$Prepare,
    [string[]]$Cases = @('verify-088.js', 'verify-090.js', 'verify-092.js', 'verify-095.js')
)
$ErrorActionPreference = 'Stop'
if ($Container -ne 'tech-ai-grafana-test') { throw 'Use the existing Grafana 13.2.2 test stand' }
$projectPath = Split-Path $PSScriptRoot -Parent
& (Join-Path $PSScriptRoot 'start-grafana.ps1')
if ($Prepare) { Write-Output 'Using local Node.js, puppeteer-core and Edge; no packages are installed in Grafana.' }
foreach ($case in ($Cases -split ',')) {
    if ($case -notmatch '^verify-[a-z0-9-]+\.js$' -or -not (Test-Path (Join-Path $projectPath ('test/' + $case)))) { throw ('Unknown test: ' + $case) }
    & node (Join-Path $PSScriptRoot 'run-browser.cjs') $case
    if ($LASTEXITCODE -ne 0) { throw ('Grafana 13.2.2 browser test failed: ' + $case) }
}
