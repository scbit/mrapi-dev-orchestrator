@echo off
set MRAPI_WORKER_IDS=W04
set MRAPI_BRAIN_ADAPTER_ID=brain_shadow_chatgpt_w04_01
set MRAPI_CHROME_PROFILE_DIR=%~dp0chrome-profiles\W04
rem Set MRAPI_W04_CHAT_URL in your local environment before starting.
npm start
