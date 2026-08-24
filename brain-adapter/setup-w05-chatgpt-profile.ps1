$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'setup-chatgpt-profile.ps1') -WorkerId 'W05' -ChatUrl $env:MRAPI_W05_CHAT_URL
