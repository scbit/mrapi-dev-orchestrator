const fs = require('fs');
const path = require('path');
const { cfg } = require('./lib/config');
const { createApi } = require('./lib/api');
const { buildCodexPrompt } = require('./adapters/codex-desktop-handoff');
const { runCodexCommand } = require('./adapters/codex-command');
const { runGitFlow, resolveGitCommand, getStatus, verifyAllowedChanges } = require('./adapters/git-flow');

if (require.main === module && !cfg.baseUrl) throw new Error('MRAPI_BASE_URL is required.');
if (require.main === module && !cfg.secret) throw new Error('MRAPI_RUNNER_SECRET is required.');

const api = createApi(cfg);
let currentRunId = null;
let stopping = false;
const MAX_ARTIFACT_FILES = 20;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

async function request(path, body) {
  return api.request(path, body);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientPollError(error) {
  const status = Number(error?.status || 0);
  return status >= 500 && status < 600;
}

function isRunAlreadyTerminalError(error) {
  return Number(error?.status || 0) === 409 &&
    (error.code === 'RUN_NOT_ACTIVE' || /RUN_NOT_ACTIVE/.test(String(error?.message || '')));
}

async function register() {
  return request('/api/runner/register', {
    executor_id: cfg.executorId,
    name: cfg.executorName,
    executor_type: 'CODEX_CLI_AUTO',
    host_name: cfg.hostName,
    host_type: 'SHADOW',
    runner_version: 'v0.4.4.12',
    capabilities: [
      'EXECUTION_RUN:CODEX_CLI_AUTO',
      'CODEX_HANDOFF:VALIDATED',
      'CODEX_EXEC:AUTO',
      'ARTIFACT_UPLOAD:AUTO',
      'GIT_STAGE:SEPARATE',
      'FILE_SCOPE:ENFORCED',
      'RESULT:AUTO',
      'LOG',
      'FILE',
      'SCREENSHOT',
      'TEST_RESULT'
    ],
    worker_ids: cfg.workerIds
  });
}

function sanitizeTaskId(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function artifactDirForTask(taskId) {
  return path.join(cfg.repoPath, '.mrapi-artifacts', sanitizeTaskId(taskId));
}

function contentTypeForFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  const types = {
    '.csv': 'text/csv',
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.json': 'application/json',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.tsv': 'text/tab-separated-values',
    '.txt': 'text/plain; charset=utf-8',
    '.webp': 'image/webp',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.zip': 'application/zip'
  };
  return types[ext] || 'application/octet-stream';
}

function listArtifactFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];

  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }

  walk(dir);
  return files.sort();
}

async function uploadTaskArtifacts(runId, taskId) {
  const dir = artifactDirForTask(taskId);
  const files = listArtifactFiles(dir);
  if (!files.length) return { uploaded: 0, dir, present: false };

  const selected = files.slice(0, MAX_ARTIFACT_FILES);
  for (const filePath of selected) {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_ARTIFACT_BYTES) {
      throw new Error(`ARTIFACT_TOO_LARGE: ${path.relative(dir, filePath)}`);
    }

    const filename = path.basename(filePath);
    await request(`/api/runner/runs/${encodeURIComponent(runId)}/evidence`, {
      type: 'FILE',
      title: filename,
      description: `Codex artifact for task ${taskId}`,
      filename,
      content_type: contentTypeForFile(filename),
      content_base64: fs.readFileSync(filePath).toString('base64')
    });
  }

  fs.rmSync(dir, { recursive: true, force: true });
  return { uploaded: selected.length, dir, present: true };
}

async function heartbeat() {
  return request('/api/runner/heartbeat', {
    executor_id: cfg.executorId,
    state: 'ONLINE',
    runner_status: currentRunId ? 'BUSY' : 'IDLE',
    current_run_id: currentRunId
  });
}

async function progress(runId, percent, message) {
  return request(`/api/runner/runs/${encodeURIComponent(runId)}/progress`, {
    progress_percent: percent,
    message
  });
}

async function markWaiting(taskId, message, handoff = null) {
  return request(`/api/runner/tasks/${encodeURIComponent(taskId)}/waiting`, {
    message,
    handoff
  });
}

async function cancellationRequested(runId) {
  const result = await request(`/api/runner/runs/${encodeURIComponent(runId)}/cancellation`, {});
  return result?.cancellation_requested === true;
}

async function addLogEvidence(runId, taskId, result) {
  const combined = [
    `TASK ${taskId}`,
    `EXIT_CODE ${result.exitCode}`,
    '',
    'STDOUT',
    result.stdout || '',
    '',
    'STDERR',
    result.stderr || ''
  ].join('\n');

  // Keep evidence bounded. Full local process output remains available in the
  // runner terminal; MRAPI receives a useful tail without excessive tokens/data.
  const capped = combined.slice(-500000);

  return request(`/api/runner/runs/${encodeURIComponent(runId)}/evidence`, {
    type: 'LOG',
    title: `Codex CLI execution ${taskId}`,
    description: `Codex CLI exited with code ${result.exitCode}`,
    filename: `codex-${taskId}.log`,
    content_type: 'text/plain; charset=utf-8',
    content_base64: Buffer.from(capped, 'utf8').toString('base64')
  });
}

async function addGitEvidence(runId, taskId, git) {
  const lines = [
    `TASK ${taskId}`,
    `GIT_CHANGED ${git.changed === true}`,
    `GIT_COMMITTED ${git.committed === true}`,
    `GIT_PUSHED ${git.pushed === true}`,
    `GIT_BRANCH ${git.branch || ''}`,
    `GIT_COMMIT_SHA ${git.commit_sha || ''}`,
    `GIT_REASON ${git.reason || ''}`,
    `GIT_ERROR ${git.error || ''}`
  ];

  return request(`/api/runner/runs/${encodeURIComponent(runId)}/evidence`, {
    type: 'LOG',
    title: `Git operation ${taskId}`,
    description: git.error || git.reason || 'Git operation completed',
    filename: `git-${taskId}.log`,
    content_type: 'text/plain; charset=utf-8',
    content_base64: Buffer.from(lines.join('\n'), 'utf8').toString('base64')
  });
}

async function completeExecution(runId, result, git = {}) {
  // Keep the Mission detail readable. The fuller process transcript is already
  // persisted separately as LOG evidence by addLogEvidence().
  const stdoutTail = String(result.stdout || '').slice(-12000);
  const stderrTail = String(result.stderr || '').slice(-8000);
  const success = result.success === true;
  const processExitedCleanly = Number(result.exitCode) === 0;
  const validationFailedAfterCleanExit = !success && processExitedCleanly;
  const validationMessage = result.scope_check?.ok === false
    ? `MRAPI file-scope validation failed: ${(result.scope_check.unauthorized_files || []).join(', ') || 'unauthorized file change'}`
    : null;

  return request(`/api/runner/runs/${encodeURIComponent(runId)}/complete`, {
    success,
    summary: git.error
      ? `Automatic Git flow failed: ${git.error}`
      : success
        ? `Codex CLI completed automatically with exit code ${result.exitCode}.`
        : validationFailedAfterCleanExit
          ? `Codex process exited with code 0, but MRAPI execution validation failed.`
          : `Codex CLI failed with exit code ${result.exitCode}.`,
    error: success
      ? null
      : (git.error || validationMessage || stderrTail || (validationFailedAfterCleanExit
          ? 'MRAPI_EXECUTION_VALIDATION_FAILED'
          : `Codex exit code ${result.exitCode}`)),
    output: {
      executor_mode: 'CODEX_CLI_AUTO',
      exit_code: result.exitCode,
      process_exited_cleanly: processExitedCleanly,
      validation_failed_after_clean_exit: validationFailedAfterCleanExit,
      stdout_tail: stdoutTail,
      stderr_tail: stderrTail,
      scope_check: result.scope_check || null,
      executor_report: result.executor_report || null,
      required_tests_failed: result.required_tests_failed === true,
      git
    }
  });
}


function parseExecutorReport(stdout) {
  const raw = String(stdout || '');
  const match = raw.match(/<MRAPI_EXECUTOR_REPORT>\s*([\s\S]*?)\s*<\/MRAPI_EXECUTOR_REPORT>/i);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function applyExecutorTestVerdict(result) {
  const report = parseExecutorReport(result?.stdout);
  result.executor_report = report;
  if (!report) return result;
  if (report.required_tests_passed === false) {
    result.success = false;
    result.stderr = `${result.stderr || ''}\nMRAPI_REQUIRED_TESTS_FAILED`;
    result.required_tests_failed = true;
  }
  return result;
}

function gitMetadataFromError(error) {
  return {
    changed: null,
    committed: false,
    pushed: false,
    commit_sha: null,
    branch: null,
    error: String(error.message || error).slice(0, 1000)
  };
}

function workingTreeStatus(repoPath) {
  const command = resolveGitCommand();
  if (!command) return { available: false, text: '', command: null };
  const status = getStatus(repoPath, command);
  return { available: status.ok, text: status.stdout || '', command, error: status.ok ? null : (status.stderr || status.stdout) };
}


function validatePreExecutionWorktree({ autopilotPhase, beforeStatus, allowedFiles }) {
  const phase = String(autopilotPhase || '').trim();
  const dirty = Boolean(beforeStatus?.available && String(beforeStatus?.text || '').trim());
  if (!phase || phase === 'GIT_STAGE' || !dirty) {
    return { ok: true, resumed_retry: false, changed_files: [], unauthorized_files: [] };
  }

  if (phase !== 'RETRY') {
    const error = new Error('AUTOPILOT_REPO_DIRTY_BEFORE_EXECUTION');
    error.code = 'AUTOPILOT_REPO_DIRTY_BEFORE_EXECUTION';
    throw error;
  }

  const priorScopeCheck = verifyAllowedChanges(beforeStatus.text, allowedFiles || []);
  if (!priorScopeCheck.ok) {
    const error = new Error('AUTOPILOT_REPO_DIRTY_OUTSIDE_RETRY_SCOPE');
    error.code = 'AUTOPILOT_REPO_DIRTY_OUTSIDE_RETRY_SCOPE';
    error.unauthorized_files = priorScopeCheck.unauthorized_files;
    throw error;
  }

  return {
    ok: true,
    resumed_retry: true,
    changed_files: priorScopeCheck.changed_files,
    unauthorized_files: []
  };
}

function allowedFilesFromClaim(claim) {
  const handoff = claim.codex_handoff || claim.task?.codex_handoff || claim.run?.codex_handoff || {};
  return Array.isArray(handoff.task_spec?.allowed_files) ? handoff.task_spec.allowed_files : [];
}

async function runTrustedGitFlow({ claim, result }) {
  if (result.success !== true) {
    return {
      changed: false,
      committed: false,
      pushed: false,
      commit_sha: null,
      branch: null,
      reason: 'CODEX_EXECUTION_FAILED'
    };
  }

  const handoff = claim.codex_handoff || claim.task?.codex_handoff || claim.run?.codex_handoff || {};
  const permissions = handoff.git_permissions || {};
  const phase = String(handoff.execution_constraints?.autopilot_phase || claim.task?.autopilot_phase || '').trim();
  const repositoryScope = String(handoff.execution_constraints?.repository_scope || '').trim();

  if (permissions.allow_commit !== true && permissions.allow_push !== true) {
    return {
      changed: true,
      committed: false,
      pushed: false,
      commit_sha: null,
      branch: null,
      reason: phase === 'GIT_STAGE' ? 'GIT_PERMISSION_NOT_GRANTED' : 'GIT_STAGE_REQUIRED',
      error: null
    };
  }
  const repositoryPath = String(handoff.repository_path || '').trim();

  // Artifact-only work has no project repository. W01 may still have trusted
  // Git permissions, but those permissions are capabilities, not a command to
  // run Git for every execution. Skip Git entirely for artifact workspaces.
  if (repositoryScope === 'ARTIFACT_WORKSPACE_ONLY' ||
      !repositoryPath ||
      repositoryPath === 'NO_REPOSITORY_ARTIFACT_WORKSPACE') {
    return {
      changed: false,
      committed: false,
      pushed: false,
      commit_sha: null,
      branch: null,
      reason: 'GIT_NOT_APPLICABLE_ARTIFACT_TASK',
      error: null
    };
  }

  try {
    const outcome = runGitFlow({
      repoPath: repositoryPath,
      gitPermissions: permissions,
      missionId: handoff.mission_id || claim.task?.mission_id,
      objective: handoff.objective || handoff.task_spec?.objective || claim.task?.objective
    });
    return {
      changed: outcome.changed === true,
      committed: outcome.committed === true,
      pushed: outcome.pushed === true,
      commit_sha: outcome.commit_sha || outcome.sha || null,
      branch: outcome.branch || permissions.allowed_branch || null,
      reason: outcome.reason || null,
      error: null
    };
  } catch (error) {
    return gitMetadataFromError(error);
  }
}

async function executeClaim(claim) {
  const { task, run: executionRun } = claim;
  const codexHandoff = claim.codex_handoff || task.codex_handoff || null;
  const handoffTask = codexHandoff ? { ...task, codex_handoff: codexHandoff } : task;
  currentRunId = executionRun.id;

  try {
    console.log('[SHADOW] EXECUTION', task.id, executionRun.id);
    await progress(executionRun.id, 10, 'Starting automatic Codex CLI execution');

    const repositoryPath = String(codexHandoff?.repository_path || cfg.repoPath || '').trim();
    const beforeStatus = workingTreeStatus(repositoryPath);
    const autopilotPhase = String(codexHandoff?.execution_constraints?.autopilot_phase || '').trim();
    const allowedFiles = allowedFilesFromClaim(claim);
    const preExecutionWorktree = validatePreExecutionWorktree({
      autopilotPhase,
      beforeStatus,
      allowedFiles
    });
    if (preExecutionWorktree.resumed_retry) {
      console.log('[SHADOW] RETRY continuing with prior allowlisted worktree changes', preExecutionWorktree.changed_files);
    }

    const prompt = buildCodexPrompt({
      task: handoffTask,
      executionRun: { ...executionRun, codex_handoff: codexHandoff },
      cfg
    });

    const result = await runCodexCommand({
      cfg,
      prompt,
      guardGitWrites: Boolean(autopilotPhase && autopilotPhase !== 'GIT_STAGE'),
      onOutput(text, stream) {
        const clean = String(text || '').trimEnd();
        if (clean) console.log(`[CODEX ${stream.toUpperCase()}]`, clean);
      },
      onProgress(percent, message) {
        return progress(executionRun.id, Math.max(10, Math.min(95, percent)), message);
      }
    });

    applyExecutorTestVerdict(result);

    const afterStatus = workingTreeStatus(repositoryPath);
    const scopeCheck = afterStatus.available
      ? verifyAllowedChanges(afterStatus.text, allowedFiles)
      : { ok: true, changed_files: [], unauthorized_files: [] };

    if (!scopeCheck.ok) {
      result.success = false;
      result.stderr = `${result.stderr || ''}\nMRAPI_FILE_SCOPE_VIOLATION: ${scopeCheck.unauthorized_files.join(', ')}`;
      result.scope_check = scopeCheck;
    } else {
      result.scope_check = scopeCheck;
    }

    try {
      await addLogEvidence(executionRun.id, task.id, result);
    } catch (evidenceError) {
      console.error('[SHADOW EVIDENCE ERROR]', evidenceError.message);
    }

    const cancelledBeforeArtifacts = await cancellationRequested(executionRun.id);
    if (cancelledBeforeArtifacts) {
      const git = {
        changed: false,
        committed: false,
        pushed: false,
        commit_sha: null,
        branch: null,
        reason: 'MISSION_CANCELLED'
      };
      await completeExecution(
        executionRun.id,
        { ...result, success: false, stderr: `${result.stderr || ''}\nMission cancellation requested.` },
        git
      );
      console.log('[SHADOW] CANCELLED_SAFE_BOUNDARY', task.id, executionRun.id);
      return;
    }

    const artifacts = await uploadTaskArtifacts(executionRun.id, task.id);
    if (artifacts.uploaded) {
      console.log('[SHADOW ARTIFACTS UPLOADED]', task.id, artifacts.uploaded);
    }

    const cancelledBeforeGit = await cancellationRequested(executionRun.id);
    const git = cancelledBeforeGit
      ? {
          changed: false,
          committed: false,
          pushed: false,
          commit_sha: null,
          branch: null,
          reason: 'MISSION_CANCELLED'
        }
      : await runTrustedGitFlow({ claim, result });
    try {
      await addGitEvidence(executionRun.id, task.id, git);
    } catch (gitEvidenceError) {
      console.error('[SHADOW GIT EVIDENCE ERROR]', gitEvidenceError.message);
    }

    const gitFailed = result.success === true && git.error;
    const completion = await completeExecution(
      executionRun.id,
      gitFailed
        ? { ...result, success: false, stderr: `${result.stderr || ''}\n${git.error}` }
        : result,
      git
    );

    console.log(
      result.success ? '[SHADOW] COMPLETE' : '[SHADOW] FAILED',
      task.id,
      executionRun.id,
      completion?.result_id || ''
    );
  } catch (error) {
    console.error('[SHADOW TASK ERROR]', error.message);

    if (isRunAlreadyTerminalError(error)) {
      console.error('[SHADOW COMPLETE SKIP]', 'Run is already terminal; not sending duplicate completion.');
      return;
    }

    if (error.message === 'CODEX_COMMAND_NOT_FOUND') {
      await markWaiting(
        task.id,
        'Codex CLI is not installed/configured on Shadow. Install/sign in once, then retry.',
        {
          type: 'CODEX_CLI_SETUP_REQUIRED',
          repository_path: cfg.repoPath,
          execution_run_id: executionRun.id
        }
      );
      console.log('[SHADOW] WAITING_CODEX_CLI_SETUP', task.id);
      return;
    }

    try {
      await request(`/api/runner/runs/${encodeURIComponent(executionRun.id)}/complete`, {
        success: false,
        summary: `Automatic Codex execution failed: ${error.message}`,
        error: String(error.stack || error.message).slice(0, 5000),
        output: {
          executor_mode: 'CODEX_CLI_AUTO',
          runner_error: error.message
        }
      });
    } catch (secondary) {
      console.error('[SHADOW COMPLETE ERROR]', secondary.message);
    }
  } finally {
    currentRunId = null;
  }
}

async function loop() {
  console.log('[SHADOW] registering', cfg.executorId, cfg.workerIds);
  await register();
  console.log('[SHADOW] registered');
  console.log('[SHADOW] repo', cfg.repoPath);
  console.log('[SHADOW] Codex mode: CLI AUTO');
  console.log('[SHADOW] configured command', cfg.codexCommand || 'auto-detect codex/codex.cmd');

  const heartbeatTimer = setInterval(() => {
    heartbeat().catch((error) =>
      console.error('[SHADOW HEARTBEAT ERROR]', error.message)
    );
  }, 30000);

  try {
    let pollFailures = 0;
    while (!stopping) {
      try {
        await heartbeat();

        const claim = await request('/api/runner/next-task', {
          executor_id: cfg.executorId,
          repository_path: cfg.repoPath
        });

        pollFailures = 0;
        if (claim) {
          console.log(
            '[SHADOW] claimed',
            claim.task.id,
            claim.run.id,
            claim.run.run_type
          );
          await executeClaim(claim);
        } else {
          await sleep(cfg.pollMs);
        }
      } catch (error) {
        if (!isTransientPollError(error)) throw error;
        pollFailures += 1;
        const backoffMs = Math.min(60000, cfg.pollMs * pollFailures);
        console.error('[SHADOW POLL ERROR]', error.message, `retrying in ${backoffMs}ms`);
        await sleep(backoffMs);
      }
    }
  } finally {
    clearInterval(heartbeatTimer);
  }
}

process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

if (require.main === module) {
  loop().catch((error) => {
    console.error('[SHADOW FATAL]', error);
    process.exit(1);
  });
}

module.exports = {
  artifactDirForTask,
  contentTypeForFile,
  listArtifactFiles,
  runTrustedGitFlow,
  uploadTaskArtifacts,
  isTransientPollError,
  isRunAlreadyTerminalError,
  workingTreeStatus,
  allowedFilesFromClaim,
  validatePreExecutionWorktree,
  parseExecutorReport,
  applyExecutorTestVerdict
};
