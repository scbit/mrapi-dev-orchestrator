# v0.3-alpha manual deploy

Deploy over existing Cloud Run service `mrapi-dev-orchestrator`.

Keep all v0.2 Cloud Run environment variables unchanged.

After deploy:
1. Existing data remains.
2. Shadow reconnects.
3. New W01 claims create BRAIN_RUN first.
4. Do not dispatch a new W01 mission until Shadow Runner is updated and W01 ChatGPT URL is configured.
