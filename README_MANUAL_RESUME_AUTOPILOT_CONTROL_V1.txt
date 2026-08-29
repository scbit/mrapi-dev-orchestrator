MRAPI DEV — MANUAL RESUME AUTOPILOT CONTROL V1

Restaura un botón manual seguro en Planner y Roadmap.

NO vuelve a START NEXT MILESTONE.
NO selecciona milestone.
NO cambia states desde UI.

Ambas pantallas llaman únicamente:
POST /api/roadmaps/:roadmapId/autopilot

El backend sigue siendo lifecycle authority e idempotente.

INSTALAR
1. Descomprimir en C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator
2. node tools\apply-manual-resume-autopilot-control-v1.js

Esperado:
MANUAL_RESUME_AUTOPILOT_CONTROL_V1_OK

TESTS
node -c src\routes\planner.ui.routes.js
node -c src\public\roadmap-page.js
node --test test\manual-resume-autopilot-control.test.js

Luego commit/push manual y deploy manual.
