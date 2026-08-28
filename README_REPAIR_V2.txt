MRAPI DEV — BRAIN PROJECT RUNTIME REPAIR V2

La primera versión ya parcheó src/routes/brain.routes.js.
Este repair completa de forma tolerante:
- brain-adapter/brain-adapter.js
- brain-adapter/lib/prompts.js

PASOS
1. Descomprimir sobre:
   C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator

2. Ejecutar:
   node tools\apply-brain-project-runtime-repair-v2.js

3. Validar:
   node -c src\routes\brain.routes.js
   node -c brain-adapter\brain-adapter.js
   node -c brain-adapter\lib\prompts.js

Debe terminar:
BRAIN_PROJECT_RUNTIME_REPAIR_V2_OK

Luego commit/push/deploy y REINICIAR el Brain Adapter W01.

En el siguiente claim de Supervisor_SCB debe verse:
[BRAIN] project project_supervisor_scb_...
[BRAIN] repo context C:\Users\Shadow\Documents\GitHub\mrapi-scb-supervisor
