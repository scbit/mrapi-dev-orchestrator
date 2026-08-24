# MRAPI DEV ORCHESTRATOR — v0.3.4-alpha.0

## Objective

Move Codex execution from manual desktop handoff to an automatic Codex CLI executor on Shadow.

Flow:

MISSION → BRAIN_RUN → W01 ChatGPT Web → BRAIN_OUTPUT → TASK → EXECUTION_RUN
→ Codex CLI on Shadow → tests/code → RESULT/EVIDENCE → MRAPI completion

## Important

- Worker is not Codex.
- Brain remains W01 ChatGPT Web.
- Executor becomes `CODEX_CLI_AUTO`.
- Host remains Shadow.
- MRAPI DEV remains the source of truth.
- Shadow receives work outbound-only.
- No GCP credentials are given to Codex.
- Codex must not deploy.
- Human manual deploy remains required when Brain says deployment is needed.

## What changes

`runner/shadow-runner.js`
- claims execution task
- consumes validated backend Codex handoff
- launches local `codex exec -`
- streams local output
- uploads bounded LOG evidence
- completes the EXISTING EXECUTION_RUN
- closes Task/Mission automatically through MRAPI

Also removes Brain recovery from the execution Runner.

## One-time Shadow prerequisite

Install the official Codex CLI and sign in using the ChatGPT account.

Official installation command:

    npm.cmd install -g @openai/codex

Then verify:

    codex --version

Launch `codex` once and complete the ChatGPT sign-in flow if requested.

After that, MRAPI Runner can auto-detect `codex` / `codex.cmd`.

Optional explicit command:

    $env:MRAPI_CODEX_COMMAND="codex exec -"

Do not set an API key unless you intentionally want API-billed execution; ChatGPT sign-in is the intended setup here.

## Tests

    node --test test/codex-cli-auto.test.js
    node --test

No Cloud Run deploy is required for this overlay because it changes only the Shadow Runner.
