MRAPI DEV — PLANNER RECOVERY DISCOVERY FIX

PROBLEMA
Después de Replay/Correct Brain, el Brain podía terminar COMPLETE y crear el Roadmap,
pero la UI de Planner seguía mostrando:
"Preparando tu plan..."

CAUSA
Actualizar plan dependía casi exclusivamente de mission.planner_roadmap_id.
En recovery/replay esa referencia puede no ser la ruta correcta para descubrir el Roadmap.

FIX
- agrega GET /api/planner/resolve
- resuelve Roadmap exacto por source_planner_mission_id / planner_request_id
- también acepta source Brain Run
- UI intenta missionId y requestId
- luego usa el resolver exacto
- persiste proposalId encontrado
- NO crea Roadmap nuevo
- NO crea Mission nueva

PASOS
node tools\apply-planner-recovery-discovery-fix.js
node -c src\routes\planner.routes.js
node -c src\routes\planner.ui.routes.js

Luego commit + push/deploy.

Después:
1. volver al Planner actual
2. NO pedir otro plan
3. click "Actualizar plan"
4. el Roadmap existente debe aparecer.
