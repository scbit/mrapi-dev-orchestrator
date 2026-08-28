MRAPI DEV — TELEGRAM DIRECT OVERLAY

Uso:
1. Descomprimir este ZIP directamente sobre la raíz de tu repo:
   mrapi-dev-orchestrator
2. Confirmar reemplazo de archivos.
3. No requiere APPLY script.

Archivos incluidos:
- src/server.js
- src/services/telegramNotifications.js
- test/telegram-notifications.test.js
- .env.example

Variables Cloud Run requeridas en el ORCHESTRATOR:
TELEGRAM_GATEWAY_URL=https://mrapi-telegram-bot-604957912671.us-central1.run.app
TELEGRAM_BUSINESS_ID=scb
TELEGRAM_CHAT_ID=<chat id>
TELEGRAM_GATEWAY_API_KEY=<misma INTERNAL_API_KEY del gateway Telegram>

Opcional:
MRAPI_PUBLIC_BASE_URL=<URL pública del Orchestrator>

Qué notifica:
- NEED_HUMAN_ACTION
- BLOCKED
- FAILED
- COMPLETED

Arquitectura:
Telegram es observabilidad solamente.
No modifica Planner, Autopilot, recovery, Shadow ni lifecycle.
Si Telegram falla, MRAPI sigue funcionando.

Después de descomprimir podés correr:
node --test test/telegram-notifications.test.js
