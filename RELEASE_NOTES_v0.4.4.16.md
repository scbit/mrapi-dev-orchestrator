# v0.4.4.16 — Autopilot contract chain fix

- Preserve `required_tests`, `diagnostic_tests`, success criteria, and stop conditions through Codex handoff.
- Parse escaped `MRAPI_AUTOPILOT` verification responses with the same transport/backslash handling as `MRAPI_CONTROL`.
- Preserve `required_tests` and `diagnostic_tests` on Brain-authored RETRY tasks.
- Require explicit `required_tests` on RETRY so executor verdict scope cannot silently disappear.
- Adds focused regression coverage for escaped verification decisions and Brain → handoff test-policy preservation.
