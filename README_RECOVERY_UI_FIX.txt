MRAPI DEV — RECOVERY UI FIX

Problema corregido:
Recovery V1 consultaba /api/missions/:id/recovery para muchas Missions simultáneamente.
Eso generaba una ráfaga de requests y Cloud Run podía responder 503.

Nuevo comportamiento:
- NO consulta recovery para cada fila.
- Solo consulta cuando el operador abre una Mission.
- Una Mission abierta = una consulta recovery.
- Si es recuperable muestra Replay Brain / Retry Execution / Resume Mission.
- Oculta el botón Retry legacy dentro del detalle cuando Recovery aplica.

INSTALAR:
Descomprimir encima de:
C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator

Reemplaza:
src/public/recovery-ui.js

Luego:
git add .
git commit -m "Fix Recovery UI request storm"
git push

Después del deploy:
Ctrl+F5
Abrir V9B.
Esperado: Replay Brain.
