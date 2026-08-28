MRAPI DEV — PLANNER RECOVERY METADATA FIX

CAUSA CONFIRMADA
Corrective Brain Replay creaba un nuevo BRAIN_RUN pero perdía:
- planning_mode
- planner_request_id
- planner_request
- non_executable
- revision Planner metadata

Entonces un Planner replay podía terminar COMPLETED pero completeBrainRun lo trataba como Brain normal y NO persistía Roadmap.

FIX
correctiveRecovery.js ahora hereda el contrato Planner del último Brain Run.

IMPORTANTE
Este fix evita el problema futuro.
Para la Mission actual hay que hacer UN NUEVO Correct Brain / Replay sobre LA MISMA MISSION,
después de deployar el fix.

Ese nuevo replay debe mostrar en /api/runs:
planning_mode: PLANNER_ROADMAP_PROPOSAL
planner_request_id: <mission/planner request id>

Entonces al completar:
Brain → parse proposal → persist Roadmap → Mission.planner_roadmap_id

NO crear:
- otra Mission
- otro Planner Request
- otro Roadmap manual

PASOS
1. Descomprimir encima de mrapi-dev-orchestrator
2. Ejecutar:
   node tools\apply-planner-recovery-metadata-fix.js
3. Validar:
   node -c src\services\correctiveRecovery.js
4. Commit + push/deploy
5. Reiniciar W01 si corresponde
6. Usar Correct Brain / Replay EN LA MISMA MISSION ACTUAL
7. Esperar BRAIN COMPLETE
8. Click Actualizar plan
