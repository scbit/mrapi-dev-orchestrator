MRAPI DEV — PLANNER SCOPED MISSIONS FIX V1

Problema confirmado:
Planner hacía GET /api/missions (hasta 100 Missions del tenant) y luego un GET /recovery por cada Mission recuperable.

Este fix:
- agrega MissionsRepository.listByRoadmap(...)
- agrega /api/missions?roadmap_id=<ID>&limit=25
- Planner carga solo Missions del Roadmap seleccionado
- limita recovery enrichment a las Missions recuperables de ese Roadmap
- limita concurrencia de recovery a 3

No toca Autopilot, lifecycle, Brain, Executor ni deploy.

INSTALACION
Descomprimir sobre:
C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator

Ejecutar:
node tools\apply-planner-scoped-missions-fix.js

Debe mostrar:
PLANNER_SCOPED_MISSIONS_FIX_V1_OK

VALIDAR:
node -c src\repositories\missions.repository.js
node -c src\routes\missions.routes.js
node -c src\routes\planner.ui.routes.js

Luego:
git diff -- src/repositories/missions.repository.js src/routes/missions.routes.js src/routes/planner.ui.routes.js

Si está bien:
git add src/repositories/missions.repository.js src/routes/missions.routes.js src/routes/planner.ui.routes.js
git commit -m "fix planner scoped mission recovery loading"
git push origin main

Después del deploy manual, en Planner > F12 > Network:
- debe aparecer /api/missions?roadmap_id=<id>&limit=25
- no debe aparecer /api/missions global desde Mission Recovery
- recovery sólo para Missions recuperables de ese Roadmap
- no deben mezclarse Missions de otros Roadmaps
