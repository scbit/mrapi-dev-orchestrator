$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'setup-chatgpt-profile.ps1') -WorkerId 'W03' -ChatUrl $env:MRAPI_W03_CHAT_URL
