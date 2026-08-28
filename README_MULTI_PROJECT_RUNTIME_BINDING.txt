MRAPI DEV — MULTI PROJECT RUNTIME BINDING

OBJETIVO
Cerrar el gap antes de usar MRAPI para proyectos reales.

INCLUYE EN UN SOLO ZIP
1. Pantalla /projects/setup para crear Project.
2. Workspace por selector.
3. Project guarda:
   - repository_full_name
   - default_branch
   - host
   - repository_path
   - runtime_binding_state
4. Planner ya tenía Workspace/Project como selectores; se conserva.
5. Planner REQUEST falla si el Project no tiene Runtime Binding READY.
6. Roadmap START vuelve a validar el mismo Project.
7. Task/Mission/project_id deben coincidir.
8. Codex handoff toma repository_path del Project, NO del repo fijo del runner.
9. Shadow soporta múltiples repos bajo MRAPI_REPO_ROOT.
10. Human Action repository_clean también puede correr en cualquier repo autorizado bajo ese root.

CADENA
Project.id
→ Planner project_id
→ Roadmap project_id
→ Mission project_id
→ Task project_id
→ Execution Run project_id
→ Project.runtime_context.repository_path
→ Shadow/Codex

FAIL CLOSED
Si hay mismatch o runtime incompleto, Executor no debe ejecutar en otro repo.

INSTALACION
1. Descomprimir este ZIP encima del repo mrapi-dev-orchestrator.
2. Desde la raíz:
   node tools/apply-multi-project-runtime.js
3. Tests:
   node --test test/project-runtime-binding.test.js
   node -c src/services/projectRuntime.js
   node -c src/routes/projects.routes.js
   node -c src/routes/project.ui.routes.js
   node -c src/routes/planner.routes.js
   node -c src/services/orchestration.js
   node -c runner/shadow-runner.js
4. Luego correr la suite habitual.
5. Commit + push.

SHADOW
No hace falta cambiar MRAPI_REPO_PATH para cada proyecto.
Nuevo default:
MRAPI_REPO_ROOT=C:\Users\Shadow\Documents\GitHub
Si no se define, usa automáticamente %USERPROFILE%\Documents\GitHub.

USO
Después del deploy:
- abrir /projects/setup
- crear SUPERVISOR SCB
- elegir Workspace
- repo: scbit/mrapi-scb-supervisor
- branch main
- Host Shadow
- local path: C:\Users\Shadow\Documents\GitHub\mrapi-scb-supervisor
- volver a /planner
- seleccionar Project SUPERVISOR SCB
- recién entonces crear Roadmap.
