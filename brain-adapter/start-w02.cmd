@echo off
set MRAPI_WORKER_IDS=W02
set MRAPI_BRAIN_ADAPTER_ID=brain_shadow_chatgpt_w02_01
set MRAPI_CHROME_PROFILE_DIR=%LOCALAPPDATA%\MRAPI\chrome-w02
rem Set MRAPI_W02_CHAT_URL in your local environment before starting.
npm start
