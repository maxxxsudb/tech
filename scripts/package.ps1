param(
    [string]$PluginPath = '',
    [string]$OutputSuffix = '',
    [string]$OutputDirectory = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Get-FileDigest([string]$Path) {
    $inputStream = [IO.File]::OpenRead($Path)
    $digest = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($digest.ComputeHash($inputStream)).Replace('-', '') }
    finally { $inputStream.Dispose(); $digest.Dispose() }
}

$projectPath = Split-Path $PSScriptRoot -Parent
if (-not $PluginPath) { $PluginPath = Join-Path $projectPath 'plugin' }
$pluginPath = (Resolve-Path -LiteralPath $PluginPath).Path
if ($OutputSuffix -notmatch '^(-protected)?$') { throw 'Unsupported output suffix' }
$manifest = Get-Content (Join-Path $pluginPath 'plugin.json') -Raw | ConvertFrom-Json
$version = $manifest.info.version
$pluginId = $manifest.id
if ($pluginId -notmatch '^[a-z0-9][a-z0-9-]+$') { throw 'Unsafe plugin ID' }
$entryPrefix = $pluginId + '/'
$moduleText = Get-Content (Join-Path $pluginPath 'module.js') -Raw
if (-not $OutputSuffix -and $moduleText -notmatch ('PLUGIN_VERSION = "' + [regex]::Escape($version) + '"')) { throw 'Module and manifest versions differ' }
$outputPath = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $projectPath 'output' }
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$archivePath = Join-Path $outputPath ($manifest.id + '-' + $version + $OutputSuffix + '.zip')
$stream = [System.IO.File]::Open($archivePath, [System.IO.FileMode]::Create)
$zip = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    Get-ChildItem -LiteralPath $pluginPath -File -Recurse | Sort-Object FullName | ForEach-Object {
        $relativePath = $_.FullName.Substring($pluginPath.Length + 1).Replace('\', '/')
        $entry = $zip.CreateEntry(($entryPrefix + $relativePath), [System.IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = if ($OutputSuffix) { [DateTimeOffset]::Parse('2020-01-01T00:00:00Z') } else { [DateTimeOffset]$_.LastWriteTime }
        $inputStream = [IO.File]::OpenRead($_.FullName)
        $entryStream = $entry.Open()
        try { $inputStream.CopyTo($entryStream) } finally { $entryStream.Dispose(); $inputStream.Dispose() }
    }
} finally { $zip.Dispose(); $stream.Dispose() }

$zip = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    foreach ($entry in $zip.Entries) {
        if (-not $entry.FullName.StartsWith($entryPrefix, [StringComparison]::Ordinal)) { throw ('Archive entry outside plugin folder: ' + $entry.FullName) }
        $relativePath = $entry.FullName.Substring($entryPrefix.Length)
        if (-not $relativePath -or $relativePath -match '(^|/)\.\.(/|$)|\\|^/') { throw ('Unsafe archive entry: ' + $entry.FullName) }
        $sourcePath = Join-Path $pluginPath $relativePath
        $sourceHash = Get-FileDigest $sourcePath
        $entryStream = $entry.Open()
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try { $entryHash = [BitConverter]::ToString($sha.ComputeHash($entryStream)).Replace('-', '') }
        finally { $entryStream.Dispose(); $sha.Dispose() }
        if ($entryHash -ne $sourceHash) { throw ('Archive mismatch: ' + $entry.FullName) }
    }
    $expectedFiles = @(Get-ChildItem -LiteralPath $pluginPath -File -Recurse).Count
    if ($zip.Entries.Count -ne $expectedFiles) { throw 'Archive file count mismatch' }
    if (-not $zip.GetEntry($entryPrefix + 'plugin.json')) { throw 'Missing plugin manifest inside plugin folder' }
    Write-Output ('Verified ' + $expectedFiles + ' plugin files')
} finally { $zip.Dispose() }
Write-Output $archivePath
Write-Output ('SHA256: ' + (Get-FileDigest $archivePath))
