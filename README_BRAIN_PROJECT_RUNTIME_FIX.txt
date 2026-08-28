MRAPI DEV — BRAIN PROJECT RUNTIME FIX

PROBLEMA
El Project/Executor ya resolvía el repo correcto, pero el Brain Adapter seguía mostrando/usando cfg.repoPath:
C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator

Eso es incorrecto para proyectos nuevos.

ESTE FIX
- /api/brain/next-run resuelve el Project por run.project_id.
- Lee runtime_context.repository_path del Project.
- Devuelve y persiste repository_path + repository_full_name en el Brain Run.
- Si runtime no está READY, falla cerrado.
- Brain Adapter registra el repo real por cada Brain Run.
- brainPrompt usa run.repository_path, no cfg.repoPath.
- Planner también recibe LOCAL REPOSITORY FOR SELECTED PROJECT.

RESULTADO ESPERADO PARA SUPERVISOR SCB
[BRAIN] project project_supervisor_scb_...
[BRAIN] repo context C:\Users\Shadow\Documents\GitHub\mrapi-scb-supervisor

INSTALACIÓN
Descomprimir encima de mrapi-dev-orchestrator y ejecutar:

node tools\apply-brain-project-runtime-fix.js
node -c src\routes\brain.routes.js
node -c brain-adapter\brain-adapter.js
node -c brain-adapter\lib\prompts.js

Luego suite habitual, commit, push/deploy y REINICIAR Brain Adapter W01.

IMPORTANTE
No hacer Replay del Planner fallido hasta que el Brain Adapter reiniciado muestre:
[BRAIN] repo context resolved per Project/Brain Run

En el siguiente claim de Supervisor debe mostrar:
C:\Users\Shadow\Documents\GitHub\mrapi-scb-supervisor
