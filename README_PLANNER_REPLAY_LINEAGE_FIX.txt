MRAPI DEV — PLANNER REPLAY LINEAGE FIX

PROBLEMA CONFIRMADO
Browser:
- requestId / missionId = Planner Mission original
- brainRunId = Brain Run viejo fallido
- proposalId = null

Recovery:
- creó/corrigió un Brain Run nuevo sobre la misma Mission
- Brain Run nuevo terminó COMPLETE
- Roadmap quedó ligado al Brain Run nuevo
- UI seguía intentando resolver usando la referencia vieja

FIX
El resolver ahora sigue:
Brain Run viejo
→ Mission
→ todos los Planner Brain Runs hermanos/replay
→ Brain Run nuevo
→ Roadmap persistido

También intenta primero cualquier planner_roadmap_id guardado directamente en la Mission.

NO CREA:
- Roadmap nuevo
- Mission nueva
- Brain Run nuevo

PASOS
1. Descomprimir sobre mrapi-dev-orchestrator.
2. Ejecutar:
   node tools\apply-planner-replay-lineage-fix.js
3. Validar:
   node -c src\routes\planner.routes.js
4. Commit + push/deploy.
5. Volver al MISMO Planner.
6. No pedir otro plan.
7. Click Actualizar plan.

Esperado:
- resolver devuelve el Roadmap existente
- UI actualiza proposalId
- UI adopta el Brain Run nuevo
- aparecen los milestones.
