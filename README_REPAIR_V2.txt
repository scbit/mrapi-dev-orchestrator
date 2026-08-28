MRAPI DEV — PLANNER RECOVERY METADATA REPAIR V2

Este repair es tolerante a diferencias locales de correctiveRecovery.js.

PASOS
1. Descomprimir sobre:
   C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator

2. Ejecutar:
   node tools\apply-planner-recovery-metadata-repair-v2.js

3. Debe terminar:
   PLANNER_RECOVERY_METADATA_REPAIR_V2_OK

4. Validar:
   node -c src\services\correctiveRecovery.js

Luego commit + push/deploy.

Después usar Correct Brain / Replay sobre LA MISMA Mission.
El nuevo Brain Run debe conservar:
planning_mode = PLANNER_ROADMAP_PROPOSAL
planner_request_id = 3ogtR6Le0vDB0sEzjuJv
