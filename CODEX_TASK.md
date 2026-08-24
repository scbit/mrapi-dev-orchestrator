# MRAPI DEV v0.4.0.2 — Brain-only Result Persistence Fix

## OBJECTIVE
Fix Brain-only Missions so the actual ChatGPT answer is persisted as a first-class MRAPI Result/Report.

Observed real bug:
- W04 Mission completed successfully.
- `requires_execution=false`
- `execution_type=BRAIN_ONLY`
- `final_result=null`
- The useful marketing answer was accidentally embedded inside `task_spec.instructions`
- Mission became COMPLETED but Reports and Evidence showed nothing.

This is incorrect.

## REQUIRED BEHAVIOR

For Brain-only Missions:

`Mission -> BRAIN_RUN -> BRAIN_OUTPUT -> RESULT -> COMPLETED`

There is no Task, Execution Run, or Evidence requirement unless the Brain explicitly produced an artifact/source/evidence.

The final user-facing Brain answer MUST be persisted into `results` and visible in:
- Mission detail
- Reports
- Result detail

## ROOT CAUSE TO INVESTIGATE
The Brain response parser appears to expect a JSON control envelope, while ChatGPT may return:
1. JSON envelope only
2. JSON envelope followed by natural-language final answer
3. Natural-language answer with embedded/partial JSON

The current parser appears to capture the prose in `task_spec.instructions` while leaving `final_result=null`.

Do not solve this by forcing the user to manually copy output.

## IMPLEMENTATION

### 1. Separate control envelope from user-facing answer
Define a robust Brain response contract.

Preferred format for new prompts:

```text
<MRAPI_CONTROL>
{
  "requires_execution": false,
  "execution_type": "BRAIN_ONLY",
  "task_spec": {
    "target_type": "MARKETING_STRATEGY",
    "browser_required": false,
    "evidence_required": false
  }
}
</MRAPI_CONTROL>

<MRAPI_RESULT>
...final user-facing answer...
</MRAPI_RESULT>
```

For execution-required Missions, result section may be empty/omitted if execution must happen first.

Do not rely on the LLM returning a single pure JSON object containing long prose.

### 2. Backward-compatible parser
Support existing responses:
- tagged control/result format
- pure JSON
- JSON followed by prose
- existing `task_spec.instructions` malformed pattern

Parser must return a normalized object like:

```js
{
  requires_execution,
  execution_type,
  task_spec,
  final_result_text,
  raw_response
}
```

Rules:
- If `requires_execution=false`, final_result_text MUST be populated.
- If tagged `<MRAPI_RESULT>` exists, use it.
- Else if JSON has `final_result` string/object, normalize it.
- Else if prose follows parsed JSON, use trailing prose.
- Else, for backward compatibility only, if `task_spec.instructions` contains the control JSON plus substantive prose, extract the substantive prose.
- If no meaningful result can be extracted, do NOT mark Mission COMPLETED. Mark BLOCKED/FAILED with a clear operational error such as `BRAIN_RESULT_MISSING`.

Do not silently complete with null result.

### 3. Persist first-class Result
When Brain-only Mission succeeds:
- create Result document
- tenant_id
- workspace_id
- project_id
- mission_id
- worker_id
- brain_run_id
- run_type = BRAIN_RUN or source_run_type
- result_type = BRAIN_RESULT / REPORT (use existing schema conventions)
- title
- content/text
- created_at
- status/success metadata

Never overwrite previous attempt history.

### 4. Reports
Ensure `/api/results` and Reports UI includes Brain-only Results.

Mission detail must show the content.

Do not require Evidence for a Brain-only text result.

### 5. Do not create fake Task
Preserve v0.4.0 behavior:
- Brain-only = no fake Task
- no Codex execution
- no Execution Run

### 6. Execution-required Missions
Do not change the existing W01/Codex flow except to use the improved control parser.

For `requires_execution=true`:
- create Task exactly as before
- `task_spec.instructions` must contain ONLY concrete executor instructions
- never stuff the Brain's final prose/report into executor instructions

### 7. Brain prompt contract
Update generic Brain prompt for W01-W05:
- ChatGPT Web is Brain.
- Return MRAPI control block separately from user-facing result.
- If Brain-only, always provide `<MRAPI_RESULT>`.
- If execution required, provide precise executor task in control block.
- Codex remains Executor only.

### 8. Existing malformed run safety
No destructive migration required.
Do not rewrite historical Brain Runs automatically.

Optional:
If Mission detail renders an older malformed Brain Output with `final_result=null`, it may show a fallback extracted preview, but canonical Results are only created for new runs/retries unless there is an existing safe retry mechanism.

### 9. Version
Bump to:
`v0.4.0.2`

## TESTS

Add focused tests:

1. Brain-only tagged response creates Result.
2. Result content appears in `/api/results`.
3. Mission detail can retrieve/render Brain-only Result.
4. Brain-only does not create Task.
5. Brain-only does not create Execution Run.
6. JSON + trailing prose extracts prose as final result.
7. `final_result` JSON field is accepted.
8. malformed old `task_spec.instructions` pattern extracts substantive prose.
9. missing Brain-only result does not mark Mission COMPLETED.
10. execution-required flow still creates Task.
11. executor instructions do not contain final-result prose.
12. W01 existing Codex flow remains green.
13. cancel/retry remains green.
14. full suite passes.

Run:
`node --test`

## SUCCESS CRITERIA
A new W04 Brain-only Mission:
- finishes COMPLETED
- creates no Task
- creates a Result
- Reports shows the campaign concepts
- Mission detail shows the campaign concepts
- Evidence may remain empty, which is correct for text-only Brain output

## STOP CONDITIONS
- Do not make Codex analyze Brain-only Missions.
- Do not create fake Tasks.
- Do not require Evidence for text-only results.
- Do not mark COMPLETED with `final_result=null`.
- Do not redesign hierarchy.
- Do not deploy.
- Do not push.

## DEPLOY
Codex:
- inspect
- implement
- test
- stop

Human:
- commit/push
- manual Cloud Run deploy
- restart Brain Adapter(s) if prompt/parser code changed
