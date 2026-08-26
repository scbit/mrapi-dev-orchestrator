# v0.4.4.15 — Brain JSON backslash parser fix

- Preserves valid JSON escaped backslashes such as Windows paths (`C:\\Users...`).
- Repairs only truly invalid JSON backslash escapes instead of corrupting valid `\\` pairs.
- Applies the same parser rule in Brain Adapter pre-validation and server-side orchestration parsing.
- Adds regression coverage for the captured W01 Autopilot contract shape.
