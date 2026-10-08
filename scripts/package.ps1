$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$projectPath = Split-Path $PSScriptRoot -Parent
$pluginPath = Join-Path $projectPath 'plugin'
$manifest = Get-Content (Join-Path $pluginPath 'plugin.json') -Raw | ConvertFrom-Json
$version = $manifest.info.version
$moduleText = Get-Content (Join-Path $pluginPath 'module.js') -Raw
if ($moduleText -notmatch ('PLUGIN_VERSION = "' + [regex]::Escape($version) + '"')) { throw 'Module and manifest versions differ' }
$outputPath = Join-Path $projectPath 'output'
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$archivePath = Join-Path $outputPath ($manifest.id + '-' + $version + '.zip')
$stream = [System.IO.File]::Open($archivePath, [System.IO.FileMode]::Create)
$zip = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    Get-ChildItem -LiteralPath $pluginPath -File -Recurse | Sort-Object FullName | ForEach-Object {
        $relativePath = $_.FullName.Substring($pluginPath.Length + 1).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $relativePath, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally { $zip.Dispose(); $stream.Dispose() }

$zip = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    foreach ($entry in $zip.Entries) {
        $sourcePath = Join-Path $pluginPath $entry.FullName
        $sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
        $entryStream = $entry.Open()
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try { $entryHash = [BitConverter]::ToString($sha.ComputeHash($entryStream)).Replace('-', '') }
        finally { $entryStream.Dispose(); $sha.Dispose() }
        if ($entryHash -ne $sourceHash) { throw ('Archive mismatch: ' + $entry.FullName) }
    }
    $expectedFiles = @(Get-ChildItem -LiteralPath $pluginPath -File -Recurse).Count
    if ($zip.Entries.Count -ne $expectedFiles) { throw 'Archive file count mismatch' }
    Write-Output ('Verified ' + $expectedFiles + ' plugin files')
} finally { $zip.Dispose() }
Write-Output $archivePath
Write-Output ('SHA256: ' + (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash)
