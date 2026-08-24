@echo off
set MRAPI_WORKER_IDS=W01
set MRAPI_BRAIN_ADAPTER_ID=brain_shadow_chatgpt_w01_01
set MRAPI_CHROME_PROFILE_DIR=%LOCALAPPDATA%\MRAPI\chrome-w01
rem Set MRAPI_W01_CHAT_URL in your local environment before starting.
npm start
