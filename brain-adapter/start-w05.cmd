@echo off
set MRAPI_WORKER_IDS=W05
set MRAPI_BRAIN_ADAPTER_ID=brain_shadow_chatgpt_w05_01
set MRAPI_CHROME_PROFILE_DIR=%LOCALAPPDATA%\MRAPI\chrome-w05
rem Set MRAPI_W05_CHAT_URL in your local environment before starting.
npm start
