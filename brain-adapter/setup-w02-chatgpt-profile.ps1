$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'setup-chatgpt-profile.ps1') -WorkerId 'W02' -ChatUrl $env:MRAPI_W02_CHAT_URL
