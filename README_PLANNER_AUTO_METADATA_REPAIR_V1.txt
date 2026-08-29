MRAPI DEV — PLANNER AUTO METADATA REPAIR V1

OBJETIVO
Eliminar la necesidad de usar F12/Console para reparar metadata dañada de Planner.

FLUJO
Planner carga Proposal
→ si proposal_type=PLANNER_ROADMAP y falta contrato de review
→ POST /api/planner/roadmaps/:id/repair-metadata
→ vuelve a leer LA MISMA Proposal
→ render normal

SEGURIDAD
- máximo 1 intento automático por Roadmap por carga de página
- no crea Roadmap
- no crea Mission
- no crea Run
- no altera lifecycle
- si repair falla, Planner sigue fail-closed mostrando INCOMPLETE
- usa el repair trusted que ya recupera desde Planner Brain Run/revision_history

INSTALAR
Descomprimir en:
C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator

Ejecutar:
node tools\apply-planner-auto-metadata-repair-v1.js

Esperado:
PLANNER_AUTO_METADATA_REPAIR_V1_OK

VALIDAR
node -c src\routes\planner.ui.routes.js
node --test test\planner-auto-metadata-repair.test.js

COMMIT
git add src/routes/planner.ui.routes.js test/planner-auto-metadata-repair.test.js
git commit -m "fix planner automatic metadata repair"
git push origin main

DEPLOY
HUMAN MANUAL DEPLOY

PRUEBA
Después del deploy:
- abrir Planner normalmente
- una Proposal Planner incompleta reparable debe auto-recuperarse
- no usar DevTools Console
- no debe entrar en loop
