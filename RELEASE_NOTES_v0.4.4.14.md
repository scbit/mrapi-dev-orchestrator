# v0.4.4.14 — Brain transport parser fix

- Normalizes ChatGPT markdown escaping before MRAPI control parsing (`\<`, `\>`, `\_`).
- Repairs invalid JSON backslashes only when they are not valid JSON escape sequences, preserving `\n` and other valid escapes.
- Applies the same normalization in the Brain Adapter preflight validator and server-side Brain response parser.
- Prevents false `BRAIN_AUTOPILOT_ALLOWED_FILES_REQUIRED` / `CODEX_HANDOFF_ALLOWED_FILES_REQUIRED` when W01 actually returned `allowed_files`.
- Adds regression coverage for the exact escaped payload observed in W01 Web output.
