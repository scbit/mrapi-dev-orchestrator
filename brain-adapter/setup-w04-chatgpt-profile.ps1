$ErrorActionPreference = 'Stop'

$workerId = 'W04'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$profileDir = Join-Path $scriptDir 'chrome-profiles\W04'
$chatUrl = $env:MRAPI_W04_CHAT_URL

if ([string]::IsNullOrWhiteSpace($chatUrl)) {
  $chatUrl = 'https://chatgpt.com/c/6a8c60e3-46ec-83e9-97c4-c9834b4c6b24'
}

New-Item -ItemType Directory -Path $profileDir -Force | Out-Null

$chromeCandidates = @(
  (Join-Path ${env:ProgramFiles} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:LocalAppData} 'Google\Chrome\Application\chrome.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

$chrome = $chromeCandidates | Select-Object -First 1
if (-not $chrome) {
  $command = Get-Command chrome.exe -ErrorAction SilentlyContinue
  if ($command) { $chrome = $command.Source }
}

if (-not $chrome) {
  throw 'Chrome executable not found. Install Google Chrome, then rerun this setup script.'
}

Write-Host "[BRAIN SETUP] $workerId profile $profileDir"
Write-Host "[BRAIN SETUP] $workerId chat $chatUrl"
Write-Host '[BRAIN SETUP] Chrome will stay visible. Log into ChatGPT once if prompted, then close Chrome and restart the W04 Brain Adapter.'
Write-Host '[BRAIN SETUP] This script never requests, stores, or reads credentials.'

Start-Process -FilePath $chrome -ArgumentList @(
  "--user-data-dir=$profileDir",
  '--new-window',
  $chatUrl
)
