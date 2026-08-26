# v0.4.4.9 — Git read-only guard fallback

- Autopilot PROGRAM/RETRY keeps Git write/network operations blocked.
- Read-only Git commands remain allowed: `status`, `diff`, `rev-parse`, `ls-files`, `log`, `show`.
- On Windows, the Runner can now locate Git even when `git.exe` is not on PATH by checking standard Git installs and GitHub Desktop bundled Git.
- `MRAPI_GIT_READ_BINARY` may explicitly point to a trusted Git binary.
- No automatic commit, push, pull, merge, rebase or deploy is enabled.
