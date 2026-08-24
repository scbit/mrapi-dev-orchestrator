# v0.3.1-alpha Manual Deploy

Deploy over the same Cloud Run service:

`mrapi-dev-orchestrator`

GCP project:

`ia-sentire-customs-broker`

No new Cloud Run variables are required.

After deploy:
1. Existing data must remain.
2. Shadow Runner must be updated to v0.3.1.
3. Create a new W01 mission.
4. Dispatch it.
5. Expected result:
   - BRAIN_RUN completes;
   - Task becomes `WAITING`;
   - phase becomes `WAITING_FOR_CODEX`;
   - W01 becomes `WAITING`;
   - no fake EXECUTION_RUN is created until Codex actually works.
