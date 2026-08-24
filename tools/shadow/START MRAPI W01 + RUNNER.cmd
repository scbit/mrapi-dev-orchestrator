@echo off
set "REPO=C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator"
start "MRAPI W01 BRAIN" cmd /k "cd /d %REPO%\brain-adapter && call start-w01.cmd"
timeout /t 2 /nobreak >nul
start "MRAPI SHADOW RUNNER" cmd /k "cd /d %REPO%\runner && npm.cmd start"
exit
