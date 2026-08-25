# Autopilot Brain allowed_files contract fix

- Preserves Brain-defined `task_spec.allowed_files` from `<MRAPI_CONTROL>`.
- Brain response is authoritative over adapter fallback task fields.
- Autopilot completion does not inject a generic task spec that can erase scope.
- PROGRAM prompt includes `allowed_files` in the required JSON shape.
- Codex remains hands only; Git write/push and deploy stay disabled during PROGRAM/RETRY.
