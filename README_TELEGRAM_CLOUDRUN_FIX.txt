MRAPI DEV TELEGRAM — CLOUD RUN FIX

PROBLEMA CORREGIDO
El Firestore onSnapshot residente no es confiable como watcher dentro de Cloud Run.
El código anterior podía iniciar el watcher pero perder el cambio de Mission.

SOLUCIÓN
- Se elimina el watcher residente de src/server.js.
- src/app.js ejecuta un sweep best-effort después de requests.
- Solo mira Missions modificadas desde el arranque de la instancia.
- Firestore notification_deliveries deduplica.
- Telegram nunca puede romper el lifecycle.

DESCOMPRIMIR
Copiar este ZIP encima de:
C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator

Reemplazar archivos.

TEST
node --test test/telegram-notifications.test.js

Luego:
git add .
git commit -m "Fix Cloud Run Telegram mission notifications"
git push

Variables existentes del Orchestrator NO cambian.
