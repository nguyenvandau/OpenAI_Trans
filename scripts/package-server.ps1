param([string]$OutputName = 'AI-Cabin-Server.zip')
$ErrorActionPreference = 'Stop'
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([System.IO.Path]::GetFileName($OutputName) -ne $OutputName -or $OutputName -notlike 'AI-Cabin-*.zip') {
  throw 'OutputName must be an AI-Cabin-*.zip filename inside this workspace.'
}
$archivePath = Join-Path $workspaceRoot $OutputName
$stagePath = [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot ('.cabin-package-' + [guid]::NewGuid().ToString('N'))))
$packageRoot = Join-Path $stagePath 'AI-Cabin'

try {
  New-Item -ItemType Directory -Path $packageRoot | Out-Null
  foreach ($name in @('server.mjs', 'realtime-interpreter.mjs', 'live-transcriber.mjs', 'server-event-guard.mjs', 'conference-glossary.mjs', 'IFR2026_glossary_EN-VI.csv', 'IFR2026_Thuat_ngu_Anh-Viet.xlsx', 'gpt-live-transcribe_EN_session.json', 'gpt-live-transcribe_VI_session.json', 'package.json', 'package-lock.json', 'README.md', 'SERVER-SETUP.md', 'PRODUCTION_ARCHITECTURE.md', 'start-server.cmd', 'start-server.sh', '.env.example')) {
    Copy-Item -LiteralPath (Join-Path $workspaceRoot $name) -Destination $packageRoot
  }
  # The server must not inherit this machine's LAN address in a fresh deployment.
  $envTemplate = [System.IO.File]::ReadAllText((Join-Path $packageRoot '.env.example'))
  $envTemplate = [regex]::Replace($envTemplate, '(?m)^PUBLIC_BASE_URL=.*$', 'PUBLIC_BASE_URL=')
  [System.IO.File]::WriteAllText((Join-Path $packageRoot '.env.example'), $envTemplate, [System.Text.UTF8Encoding]::new($false))
  foreach ($name in @('public', 'test', 'deploy')) {
    Copy-Item -LiteralPath (Join-Path $workspaceRoot $name) -Destination $packageRoot -Recurse
  }
  New-Item -ItemType Directory -Path (Join-Path $packageRoot 'scripts') | Out-Null
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'check-server.mjs') -Destination (Join-Path $packageRoot 'scripts')
  # Explicit line endings make the launchers usable on their respective systems.
  foreach ($launcher in @('start-server.cmd', 'start-server.sh')) {
    $launcherPath = Join-Path $packageRoot $launcher
    $content = [System.IO.File]::ReadAllText($launcherPath).Replace("`r`n", "`n")
    if ($launcher -like '*.cmd') { $content = $content.Replace("`n", "`r`n") }
    [System.IO.File]::WriteAllText($launcherPath, $content, [System.Text.UTF8Encoding]::new($false))
  }
  Push-Location $packageRoot
  try {
    & npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Installing production dependencies failed.' }
  } finally { Pop-Location }

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  # Use ZipArchive explicitly so dotfiles are included and entry paths use forward slashes.
  $archiveStream = [System.IO.File]::Open($archivePath, [System.IO.FileMode]::Create)
  $archive = [System.IO.Compression.ZipArchive]::new($archiveStream, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($file in Get-ChildItem -LiteralPath $packageRoot -Recurse -File -Force) {
      $relativePath = $file.FullName.Substring($stagePath.Length + 1).Replace('\', '/')
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $relativePath, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally { $archive.Dispose(); $archiveStream.Dispose() }
  Get-Item -LiteralPath $archivePath | Select-Object FullName, Length
} finally {
  # Delete only the uniquely named staging directory inside this workspace.
  $safePrefix = $workspaceRoot.TrimEnd('\') + '\.cabin-package-'
  if ($stagePath.StartsWith($safePrefix, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $stagePath)) {
    Remove-Item -LiteralPath $stagePath -Recurse -Force
  }
}
