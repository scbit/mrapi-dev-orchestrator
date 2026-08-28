MRAPI DEV — RECOVERY FIRESTORE TRANSACTION FIX

Fix del POST /api/missions/:missionId/recover 500.
Causa: replayAutopilotBrain hacía tx.get(roadmapRef) después de tx.set(),
y Firestore exige todas las lecturas antes de cualquier escritura dentro de una transacción.

Instalar encima de:
C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator

Reemplaza:
src/services/missionRecovery.js

Después:
node -c src/services/missionRecovery.js
node --test test/mission-recovery.test.js

git add .
git commit -m "Fix Recovery Firestore transaction ordering"
git push

Luego repetir Replay Brain sobre la misma Mission V9B.
