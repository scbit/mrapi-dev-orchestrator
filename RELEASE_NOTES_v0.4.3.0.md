# v0.4.3.0 — Project Context + Roadmap Base

This release establishes the persistent control layer required before W01 Autopilot.

## Project Context
Tenant-scoped Project API now stores reusable execution context:
- repository URL / full name
- Shadow local path
- default branch
- default Worker
- reusable stable instructions
- non-secret runtime context references

Secrets are explicitly rejected from runtime_context.

## Roadmap Base
Adds tenant/project-scoped Roadmap Goals with:
- state
- priority
- owner Worker
- ordered milestones
- dependencies
- success criteria
- linked Mission IDs
- auto_advance flag (storage only in this release)
- deterministic next-milestone selection

## UI
A focused initial editor is available at `/roadmap.html`.
The main Control Room integration comes after the Autopilot kernel is stable.

## Architecture
Brain remains responsible for planning/programming/orchestration.
Codex remains Executor/hands only.
