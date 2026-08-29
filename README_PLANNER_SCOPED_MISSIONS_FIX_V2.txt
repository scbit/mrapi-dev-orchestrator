MRAPI DEV — PLANNER SCOPED MISSIONS FIX V2

Este V2 reemplaza al V1.
Es compatible con:
- cambios de m3
- CRLF/LF
- ejecución parcial previa del V1
- rerun idempotente

ANTES DE EJECUTAR
No hagas commit del intento V1.

INSTALACION
Descomprimir sobre:
C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator

Ejecutar:
node tools\apply-planner-scoped-missions-fix-v2.js

Esperado:
PLANNER_SCOPED_MISSIONS_FIX_V2_OK

VALIDAR:
node -c src\repositories\missions.repository.js
node -c src\routes\missions.routes.js
node -c src\routes\planner.ui.routes.js

REVISAR:
git diff -- src/repositories/missions.repository.js src/routes/missions.routes.js src/routes/planner.ui.routes.js

El diff esperado:
- listByRoadmap(...)
- GET /api/missions soporta roadmap_id + limit
- Planner loadMissionsRecovery usa roadmap_id + limit=25
- no GET /api/missions global desde Mission Recovery
- recovery limitado a concurrencia 3

NO TOCA:
- Autopilot
- lifecycle
- Brain
- Executor
- deploy

Si todo está correcto:
git add src/repositories/missions.repository.js src/routes/missions.routes.js src/routes/planner.ui.routes.js
git commit -m "fix planner scoped mission recovery loading"
git push origin main

Deploy: HUMAN MANUAL DEPLOY.
