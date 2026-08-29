V2 robusto.

Ejecutar:
node tools\apply-roadmap-metadata-repair-and-recent-goals-v2.js

Luego:
node -c src\services\roadmap.js
node -c src\services\planner.js
node -c src\routes\planner.routes.js
node -c src\public\roadmap-page.js
node --test test\roadmap-metadata-repair-and-recent-goals-v2.test.js

Después mandar git status antes de commit.
