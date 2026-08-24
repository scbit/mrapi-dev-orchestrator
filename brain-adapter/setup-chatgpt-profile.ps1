param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('W01', 'W02', 'W03', 'W04', 'W05')]
  [string]$WorkerId,

  [Parameter(Mandatory = $true)]
  [string]$ChatUrl
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ChatUrl)) {
  throw "MRAPI_${WorkerId}_CHAT_URL is required. Set it to that worker's dedicated ChatGPT conversation URL, then rerun this setup script."
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$profileDir = Join-Path $scriptDir "chrome-profiles\$WorkerId"
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

Write-Host "[BRAIN SETUP] $WorkerId profile $profileDir"
Write-Host "[BRAIN SETUP] $WorkerId chat $ChatUrl"
Write-Host "[BRAIN SETUP] Chrome will stay visible. Log into ChatGPT once if prompted, then close Chrome and restart the $WorkerId Brain Adapter."
Write-Host '[BRAIN SETUP] This script never requests, stores, or reads credentials.'

Start-Process -FilePath $chrome -ArgumentList @(
  "--user-data-dir=$profileDir",
  '--new-window',
  $ChatUrl
)
