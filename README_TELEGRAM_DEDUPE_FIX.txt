MRAPI DEV TELEGRAM — DEDUPE FIX

Problema:
Llegaban 2 mensajes porque dos instancias/requests de Cloud Run podían leer
notification_deliveries antes de que ninguna hubiera reservado el envío.

Fix:
La reserva PENDING ahora se hace dentro de una transacción Firestore.
Solo una instancia gana el lock y envía Telegram.
Las demás reciben ALREADY_PENDING / ALREADY_SENT.

Descomprimir encima de:
C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator

Reemplaza:
src/services/telegramNotifications.js
test/telegram-notifications.test.js

Test:
node --test test/telegram-notifications.test.js
