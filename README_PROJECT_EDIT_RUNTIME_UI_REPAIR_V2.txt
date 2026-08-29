MRAPI DEV — PROJECT EDIT RUNTIME UI REPAIR V2

Este repair es tolerante a diferencias locales de project.ui.routes.js.

PASOS
1. Descomprimir sobre:
   C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator

2. Ejecutar:
   node tools\apply-project-edit-runtime-ui-repair-v2.js

3. Debe mostrar:
   PROJECT_EDIT_RUNTIME_UI_REPAIR_V2_OK

4. Validar:
   node -c src\routes\project.ui.routes.js

5. Commit + push/deploy.

Luego:
   /projects/setup
   → SCB Development
   → Editar
   → completar runtime
   → Guardar cambios

Esperado:
   SCB Development READY
