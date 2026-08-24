$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'setup-chatgpt-profile.ps1') -WorkerId 'W04' -ChatUrl $env:MRAPI_W04_CHAT_URL
