MRAPI DEV — MANUAL RESUME AUTOPILOT CONTROL V2

V2 tolera el Planner actual aunque m3 haya cambiado/eliminado la antigua variable canStart.

OBJETIVO
Restaurar un control humano permanente y seguro:
START AUTOPILOT / RESUME AUTOPILOT

REGLAS
- Visible en Roadmap aprobado, no terminal y con milestones pendientes.
- No selecciona milestone.
- No usa /advance.
- No cambia milestone state.
- Llama solo POST /api/roadmaps/:roadmapId/autopilot.
- Backend Autopilot sigue siendo la unica lifecycle authority.

INSTALAR
Descomprimir sobre:
C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator

Ejecutar:
node tools\apply-manual-resume-autopilot-control-v2.js

Esperado:
MANUAL_RESUME_AUTOPILOT_CONTROL_V2_OK

TESTS
node -c src\routes\planner.ui.routes.js
node -c src\public\roadmap-page.js
node --test test\manual-resume-autopilot-control-v2.test.js

Luego commit/push manual y deploy manual.
