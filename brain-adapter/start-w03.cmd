@echo off
set MRAPI_WORKER_IDS=W03
set MRAPI_BRAIN_ADAPTER_ID=brain_shadow_chatgpt_w03_01
set MRAPI_CHROME_PROFILE_DIR=%~dp0chrome-profiles\W03
rem Set MRAPI_W03_CHAT_URL in your local environment before starting.
npm start
