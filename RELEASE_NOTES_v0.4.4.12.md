# v0.4.4.12 — Autopilot Test Policy

- Separates required scoped tests from broader diagnostic/full-suite tests.
- Required tests determine executor verification.
- Diagnostic failures are reported to the Brain but do not by themselves fail the executor when required tests pass.
- Adds structured MRAPI_EXECUTOR_REPORT parsing.
- Preserves file-scope enforcement, Git write prohibition, and manual deploy.
