MRAPI DEV — PROJECT EDIT RUNTIME UI V1

OBJETIVO
Agregar edición de Runtime Binding para Projects existentes en /projects/setup.

NO cambia el backend:
la API ya soporta:
PUT /api/projects/:projectId/runtime

CAMBIO UI
Cada Project existente muestra:
[ Editar ]

Al editar, se precargan:
- Project name (solo lectura)
- Project ID (solo lectura)
- GitHub repository
- Branch
- Host
- Local path en Shadow

Guardar usa el mismo project_id y actualiza únicamente el Runtime Binding.
NO crea otro Project.

INSTALACIÓN
1. Descomprimir sobre:
   C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator

2. Ejecutar:
   node tools\apply-project-edit-runtime-ui.js

Debe mostrar:
   PROJECT_EDIT_RUNTIME_UI_V1_OK

3. Validar:
   node -c src\routes\project.ui.routes.js

4. Commit + push/deploy del Orchestrator según tu flujo normal.

USO
/projects/setup
→ SCB Development
→ Editar
→ completar:

GitHub repository:
scbit/mrapi-dev-orchestrator

Branch:
main

Host:
Shadow

Local path:
C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator

→ Guardar cambios

Esperado:
SCB Development READY
