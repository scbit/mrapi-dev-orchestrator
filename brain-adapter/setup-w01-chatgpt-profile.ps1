$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'setup-chatgpt-profile.ps1') -WorkerId 'W01' -ChatUrl $env:MRAPI_W01_CHAT_URL
