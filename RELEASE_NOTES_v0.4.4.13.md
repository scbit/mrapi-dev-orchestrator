# Autopilot Brain Contract Self-Repair

- W01 PROGRAM responses are validated in the Brain Adapter before MRAPI completion.
- Missing/malformed MRAPI_CONTROL or empty task_spec.allowed_files triggers one automatic repair prompt in the same W01 chat.
- Backend hard guard prevents creation of an unsafe Executor task when allowed_files is still missing.
- Failure is now classified at BRAIN_CONTRACT instead of surfacing later as CODEX_HANDOFF_ALLOWED_FILES_REQUIRED.
