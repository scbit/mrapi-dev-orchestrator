MRAPI DEV — RECOVERY / REPLAY V1

Objetivo:
Recuperar una Mission existente sin crear otro Roadmap ni otra business Mission.

Clasificaciones:
- BRAIN_REPLAY -> Replay Brain
- EXECUTION_RETRY -> Retry Execution
- HUMAN_ACTION_RESUME -> Resume Mission
- NO_ACTION -> no toca nada

Endpoints:
GET  /api/missions/:missionId/recovery
POST /api/missions/:missionId/recover

UI:
El Control Room agrega automáticamente el botón correcto:
Replay Brain / Retry Execution / Resume Mission.

Arquitectura:
- MRAPI decide recovery.
- Brain sigue siendo Brain.
- Codex sigue siendo Executor.
- Shadow sigue siendo Host.
- Recovery no crea una nueva business Mission.
- Para Autopilot Brain replay conserva roadmap_id, milestone_id, brain_context y PROGRAM/phase.
- Repeated Recover reutiliza un Brain Run activo y evita duplicar el intento.

INSTALAR
Descomprimir encima de la raíz:
C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator

Reemplazar archivos.

TEST
node --test test/mission-recovery.test.js

Después correr los tests críticos existentes:
node --test test/autopilot-human-action-resume.test.js
node --test test/autopilot-auto-advance.test.js
node --test test/cancel-retry-v0391.test.js

No hace push ni deploy automáticamente.
