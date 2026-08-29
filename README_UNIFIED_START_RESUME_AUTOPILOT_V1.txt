MRAPI DEV — UNIFIED START / RESUME AUTOPILOT V1

OBJETIVO
Restaurar el control humano práctico sin volver a crear una segunda autoridad de lifecycle.

COMPORTAMIENTO
- Planner y Roadmap muestran Start/Resume Autopilot.
- Ambos llaman EXACTAMENTE al mismo backend:
  POST /api/roadmaps/:roadmapId/autopilot
- El usuario NO selecciona milestone.
- Backend deriva qué corresponde desde trusted persisted state.
- Si hay work activo/recoverable: no crea duplicados.
- Si m1..m3 están COMPLETE y m4 está PENDING: Resume Autopilot inicia m4.
- Si nunca inició: Start Autopilot inicia el primer milestone elegible.
- Si Roadmap está terminal: botón oculto.
- BLOCKED/FAILED/WAITING_HUMAN siguen usando recovery sobre la misma Mission.

NO REINTRODUCE
- /advance como autoridad
- Start Next Milestone manual
- direct milestone state mutation
- selección manual de milestone

ARCHIVOS
- src/services/planner.js
- src/routes/roadmaps.routes.js
- src/routes/planner.ui.routes.js
- src/public/roadmap-page.js
- src/public/roadmap.html
- test/unified-start-resume-autopilot.test.js

INSTALACION
Descomprimir sobre:
C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator

Ejecutar:
node tools\apply-unified-start-resume-autopilot-v1.js

Debe mostrar:
UNIFIED_START_RESUME_AUTOPILOT_V1_OK

VALIDAR:
node -c src\services\planner.js
node -c src\routes\roadmaps.routes.js
node -c src\routes\planner.ui.routes.js
node -c src\public\roadmap-page.js
node --test test\unified-start-resume-autopilot.test.js

Luego:
git status
git diff -- src/services/planner.js src/routes/roadmaps.routes.js src/routes/planner.ui.routes.js src/public/roadmap-page.js src/public/roadmap.html test/unified-start-resume-autopilot.test.js

COMMIT/PUSH
git add src/services/planner.js src/routes/roadmaps.routes.js src/routes/planner.ui.routes.js src/public/roadmap-page.js src/public/roadmap.html test/unified-start-resume-autopilot.test.js
git commit -m "fix unified start resume autopilot control"
git push origin main

DEPLOY
HUMAN MANUAL DEPLOY.

PRUEBA CLAVE
Roadmap actual:
m1 COMPLETE
m2 COMPLETE
m3 COMPLETE
m4 PENDING
m5 PENDING

Después del deploy:
- Planner debe mostrar RESUME AUTOPILOT.
- Roadmap debe mostrar RESUME AUTOPILOT.
- cualquiera de los dos debe iniciar m4.
- NO debe crear una nueva Mission para m1/m2/m3.
- al refrescar el otro UI debe reflejar exactamente el mismo trusted state.
