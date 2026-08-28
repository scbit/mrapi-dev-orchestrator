MRAPI DEV — MULTI PROJECT RUNTIME REPAIR V2

Este ZIP corrige SOLO el instalador de Multi Project Runtime Binding.
La V1 ya dejó archivos nuevos y aplicó parcialmente app/planner.

PASOS
1. Descomprimir encima de:
   C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator

2. Ejecutar:
   node tools\apply-multi-project-runtime-repair-v2.js

3. Debe terminar:
   MULTI_PROJECT_RUNTIME_REPAIR_V2_OK

4. Validar:
   node -c src\services\orchestration.js
   node -c src\routes\planner.routes.js
   node -c src\routes\runner.routes.js
   node -c runner\shadow-runner.js
   node --test test\project-runtime-binding.test.js

NO hacer commit antes de que el patcher termine OK.
