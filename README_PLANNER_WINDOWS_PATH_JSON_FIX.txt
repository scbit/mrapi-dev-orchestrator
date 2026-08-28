MRAPI DEV — PLANNER WINDOWS PATH JSON FIX

CAUSA CONFIRMADA
El Brain devolvió un Roadmap correcto pero con rutas Windows crudas dentro del JSON:
C:\Users\Shadow\Documents\GitHub\mrapi-scb-supervisor

JSON no acepta \U, \D, \G, etc. como escapes.
Por eso JSON.parse() fallaba con:
PLANNER_PROPOSAL_JSON_INVALID

FIX
1. Brain prompt exige:
   - forward slashes, o
   - backslashes escapadas.
2. Planner parser hace un segundo intento seguro reparando únicamente backslashes
   inválidas dentro de strings JSON.
3. Escapes JSON válidos (\n, \t, \u, \", \\) se preservan.

PASOS
1. Descomprimir sobre mrapi-dev-orchestrator.
2. Ejecutar:
   node tools\apply-planner-windows-path-json-fix.js
3. Validar:
   node -c src\services\planner.js
   node -c brain-adapter\lib\prompts.js
4. Commit + push/deploy.
5. Reiniciar W01 Brain Adapter.

DESPUÉS
Podés pedir/replayar el Planner.
No debería volver a fallar por rutas Windows sin escapar.
