# MRAPI DEV v0.4.0-alpha.0 — Common Worker Runtime

## OBJECTIVE
Generalize the current working W01 architecture to W01–W05 with one common runtime model.

Fixed architecture:
- ChatGPT Web = Brain
- Codex = Executor
- Shadow = initial Host
- MRAPI DEV = source of truth

Core rule:
**1 WORKER = 1 CHAT**

Codex is implemented and available for every Worker, but each Mission may or may not need execution.

## NON-NEGOTIABLE
The Brain thinks.
Codex executes.

Codex must NOT become the planner, strategist, or architect.
It receives concrete instructions from the Brain.

## TARGET WORKERS
- W01 Software Engineer
- W02 US Real Estate Analyst
- W03 Sentire Marine / Segue Agent
- W04 SCB Marketing Creator
- W05 SCB Marketing Analyst

## RUNTIME MODEL

Every Worker has:
- worker profile
- Brain binding
- Executor binding
- Host binding
- permissions
- mission policy

Initial defaults:
- Brain provider: ChatGPT Web
- Executor provider: Codex
- Host: Shadow

These are bindings, not hardcoded identities.

## IMPLEMENTATION

### 1. Worker-specific Brain chats
Support:
- `MRAPI_W01_CHAT_URL`
- `MRAPI_W02_CHAT_URL`
- `MRAPI_W03_CHAT_URL`
- `MRAPI_W04_CHAT_URL`
- `MRAPI_W05_CHAT_URL`

Provide:
`chatUrlForWorker(workerId)`

Never fall back from one Worker to another Worker chat.

If missing:
`BRAIN_CHAT_NOT_CONFIGURED_FOR_<WORKER>`

### 2. Independent Brain runtime per Worker
Production/default model:
**one Brain Adapter process per Worker**

Examples:
- W01 Brain Adapter
- W02 Brain Adapter
- W03 Brain Adapter
- W04 Brain Adapter
- W05 Brain Adapter

One generic codebase, different env configuration.

Each Adapter registers:
- brain_adapter_id
- worker_id
- host
- version
- current Brain Run
- health

### 3. Independent Chrome profiles
Per Worker:
- W01 → chrome-w01
- W02 → chrome-w02
- W03 → chrome-w03
- W04 → chrome-w04
- W05 → chrome-w05

Same ChatGPT account is allowed.
Same ChatGPT chat is NOT allowed.

### 4. Worker Brain profiles
Create data-driven Brain profiles.

Suggested:
`brain-adapter/lib/worker-profiles.js`

Each profile must define:
- worker_id
- role
- mission
- planning instructions
- output contract
- executor availability
- permission expectations

W01:
Brain plans coding work for Codex.

W02:
Brain analyzes real estate.
Codex may browse web, collect comps, generate files/reports, screenshots.

W03:
Brain analyzes marine market/opportunities.
Codex may browse dealers, brokers, competitors, sources, reports.

W04:
Brain creates marketing strategy/campaign instructions.
Codex may:
- operate Meta Ads
- use HeyGen
- upload creatives
- prepare files
- take screenshots
- execute campaign setup
Publishing only when permission allows.

W05:
Brain analyzes campaign performance.
Codex may:
- operate Meta Ads
- read/export metrics
- gather campaign data
- take screenshots
- return structured evidence
Brain does final analysis and recommendations.

### 5. Executor available for all Workers
Every Worker must have an Executor binding.

Initial binding:
- provider: Codex
- host: Shadow

But Mission logic can decide:
- Brain-only
- Brain + Codex

Do NOT force a fake Task when Brain-only is enough.
Do NOT remove Executor capability from any Worker.

### 6. Brain decides execution need
Brain output contract must include something like:

```json
{
  "requires_execution": true,
  "execution_type": "CODEX",
  "task_spec": {}
}
```

or:

```json
{
  "requires_execution": false,
  "final_result": {}
}
```

MRAPI validates this against Worker permissions/capabilities.

If `requires_execution=false`:
- Brain Run can produce Result and complete Mission.

If `requires_execution=true`:
- create Task
- Runner/Codex executes
- evidence/result returned
- Brain remains the reasoning authority

### 7. Codex contract
Codex prompt must always say:
- You are the Executor, not the Brain.
- Follow the Brain task spec.
- Do not redesign strategy.
- Do not invent business objectives.
- Do not change Worker role.
- Do not access GCP unless explicitly permitted by architecture (currently no).
- Do not deploy unless explicit permission exists.
- Return evidence/results.

### 8. Executor routing
Runner may support all five Worker IDs.

But claim logic must remain scoped:
- tenant
- worker
- capabilities
- permissions

Codex is available to all Workers.
Git commit/push remains W01-only initially.

W02–W05 must NOT inherit W01 Git permissions.

### 9. Browser execution readiness
Do not hardcode Meta/HeyGen into the Worker entity.

Model them as external targets/connections that Codex/Browser Executor can use.

Prepare execution metadata such as:
- target_type
- target_name
- browser_required
- evidence_required

This enables:
- Meta Ads
- HeyGen
- Realtor/Zillow/etc.
- dealer sites
- other web tools later

without redesign.

### 10. Marketing-first readiness
W04/W05 must be fully represented in runtime now.

W04 execution-capable:
- campaign creation
- copy/creative handling
- HeyGen workflow
- Meta Ads setup
- evidence

W05 execution-capable:
- Meta Ads inspection
- metrics export/read
- screenshots
- structured dataset/evidence
- Brain final analysis

Do not auto-publish yet unless `allow_publish=true`.

### 11. Startup scripts
Add generic templates:
- `brain-adapter/start-w01.cmd`
- `brain-adapter/start-w02.cmd`
- `brain-adapter/start-w03.cmd`
- `brain-adapter/start-w04.cmd`
- `brain-adapter/start-w05.cmd`

No secrets in Git.

Each script/config must set only:
- worker id
- brain adapter id
- worker-specific Chrome profile
- worker-specific chat variable reference

Do not auto-start W02–W05 until chat URLs are configured.

### 12. UI
Workers view should show:
- Brain configured YES/NO
- Brain health
- Executor configured YES/NO
- Executor health
- Host
- autonomy level
- permissions
- current Mission

Do not show full ChatGPT URLs.

### 13. Health
Health per Worker must evaluate:
- Brain
- Executor
- Worker state

Since Executor exists for all Workers, show its readiness for all.

If Brain is online but Executor offline:
- Worker can still be `DEGRADED`
- Brain-only Mission may still run
- execution-requiring Mission must become BLOCKED/Need Attention

### 14. Version
Set:
`v0.4.0-alpha.0`

Preserve:
- v0.3.9.1 cancel/retry
- v0.3.8.1 auto Git for W01
- Evidence/Artifacts
- Runner/Brain health

## TESTS
At minimum verify:

1. Five Worker profiles exist.
2. Five independent chat bindings.
3. No chat fallback between Workers.
4. Five independent Chrome profiles.
5. Brain profiles for W01–W05.
6. Every Worker has Executor binding.
7. W01 Git permissions remain only W01.
8. W04/W05 have Codex execution capability.
9. Brain-only Mission can complete without fake Task.
10. Execution Mission creates Task.
11. Codex receives Brain task spec, not raw Mission strategy.
12. Missing Brain chat blocks only that Worker.
13. Executor offline blocks execution-required Mission but not unrelated workers.
14. W04/W05 do not publish unless permission allows.
15. Existing cancel/retry tests pass.
16. Existing Git tests pass.
17. Full suite passes.

Run:
`node --test test\common-worker-runtime-v040.test.js`
`node --test`

## SUCCESS CRITERIA
- One common architecture supports W01–W05.
- ChatGPT Web remains Brain for every Worker.
- Codex is implemented as Executor for every Worker.
- Brain-only Missions are allowed.
- Execution Missions use Codex.
- W04/W05 are ready for Meta Ads and HeyGen workflows.
- No Worker shares a ChatGPT chat.
- No W02–W05 Git push permission leakage.
- Full suite passes.

## STOP CONDITIONS
- Do not make Codex the Brain.
- Do not put two Workers in one ChatGPT chat.
- Do not force Codex on every Mission.
- Do not remove Codex from any Worker runtime.
- Do not auto-publish.
- Do not auto-deploy.
- Do not push during this manual implementation.
- Do not weaken tenant isolation.
- Do not redesign core hierarchy.

## DEPLOY
For this manual implementation:
- Codex implements.
- Codex tests.
- DO NOT deploy.
- DO NOT push.
- Human does one manual commit/push/deploy.
- Restart affected Brain Adapter/Runner processes.

After deploy:
Configure W04 and W05 chats first.
