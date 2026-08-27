const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: options.env || process.env
  });

  return {
    ok: result.status === 0,
    status: result.status,
    // IMPORTANT: git status --porcelain uses leading spaces as status bytes.
    // trim() corrupts the first line by removing a leading space, e.g.
    // " M runner/shadow-runner.js" -> "M runner/shadow-runner.js".
    // parseStatusFiles() then drops the first real filename character.
    stdout: String(result.stdout || '').trimEnd(),
    stderr: String(result.stderr || '').trim(),
    error: result.error || null
  };
}

function githubDesktopGitCandidates(env = process.env) {
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) return [];

  const root = path.join(localAppData, 'GitHubDesktop');
  if (!fs.existsSync(root)) return [];

  let appDirs = [];
  try {
    appDirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^app-/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return [];
  }

  const candidates = [];
  for (const appDir of appDirs) {
    candidates.push(
      path.join(root, appDir, 'resources', 'app', 'git', 'cmd', 'git.exe'),
      path.join(root, appDir, 'resources', 'app', 'git', 'mingw64', 'bin', 'git.exe')
    );
  }
  return candidates;
}

function resolveGitCommand(env = process.env) {
  const candidates = process.platform === 'win32'
    ? [
        'git.exe',
        'C:\\Program Files\\Git\\cmd\\git.exe',
        'C:\\Program Files\\Git\\bin\\git.exe',
        ...githubDesktopGitCandidates(env)
      ]
    : ['git'];

  for (const command of candidates) {
    const check = run(command, ['--version'], { env });
    if (check.ok) return command;
  }

  return null;
}

function ensureGitCommand(gitCommand) {
  const command = gitCommand || resolveGitCommand();
  if (!command) throw new Error('GIT_COMMAND_NOT_FOUND');
  return command;
}

function getStatus(repoPath, gitCommand, commandRunner = run) {
  return commandRunner(gitCommand, ['status', '--porcelain=v1'], { cwd: repoPath });
}

function hasChanges(statusText) {
  return String(statusText || '').trim().length > 0;
}

function parseStatusFiles(statusText) {
  return String(statusText || '')
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .map((file) => file.includes(' -> ') ? file.split(' -> ').pop() : file);
}

function parseStatusEntries(statusText) {
  return String(statusText || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const index = line[0] || ' ';
      const worktree = line[1] || ' ';
      const raw = line.slice(3).trim();
      const renameParts = raw.includes(' -> ') ? raw.split(' -> ') : null;
      const source = renameParts ? renameParts[0] : null;
      const destination = renameParts ? renameParts[renameParts.length - 1] : raw;
      return {
        line,
        index,
        worktree,
        raw,
        path: destination,
        source,
        paths: renameParts ? [source, destination] : [destination],
        staged: index !== ' ' && index !== '?'
      };
    })
    .filter((entry) => entry.path);
}

function hasEnvFile(statusText) {
  return parseStatusFiles(statusText).some((file) => {
    const name = path.basename(file).toLowerCase();
    return name === '.env' || name.startsWith('.env.');
  });
}

function currentBranch(repoPath, gitCommand, commandRunner = run) {
  const branch = commandRunner(gitCommand, ['branch', '--show-current'], { cwd: repoPath });
  if (!branch.ok || !branch.stdout) {
    throw new Error(`GIT_BRANCH_FAILED: ${branch.stderr || branch.stdout}`);
  }
  return branch.stdout;
}

function gitDir(repoPath, gitCommand, commandRunner = run) {
  const dir = commandRunner(gitCommand, ['rev-parse', '--git-dir'], { cwd: repoPath });
  if (!dir.ok || !dir.stdout) {
    throw new Error(`GIT_DIR_FAILED: ${dir.stderr || dir.stdout}`);
  }
  return path.resolve(repoPath, dir.stdout);
}

function verifyPreconditions(repoPath, gitCommand, commandRunner = run) {
  const tree = commandRunner(gitCommand, ['rev-parse', '--is-inside-work-tree'], { cwd: repoPath });
  if (!tree.ok || tree.stdout !== 'true') {
    throw new Error('GIT_NOT_WORK_TREE');
  }

  const dir = gitDir(repoPath, gitCommand, commandRunner);
  const blocked = [
    'MERGE_HEAD',
    'REBASE_HEAD',
    'rebase-apply',
    'rebase-merge'
  ].some((entry) => fs.existsSync(path.join(dir, entry)));
  if (blocked) throw new Error('GIT_UNRESOLVED_MERGE_OR_REBASE');

  return { branch: currentBranch(repoPath, gitCommand, commandRunner), gitDir: dir };
}

function shortObjective(value) {
  return String(value || 'software mission')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 72) || 'software mission';
}

function commitMessageFor({ missionId, roadmapId, milestoneId, attempt, objective }) {
  return [
    `MRAPI ${missionId || 'mission'}: ${shortObjective(objective)}`,
    '',
    `Roadmap: ${roadmapId || 'unknown'}`,
    `Milestone: ${milestoneId || 'unknown'}`,
    `Attempt: ${Number(attempt || 1)}`
  ].join('\n');
}

function normalizePermissions(gitPermissions = {}) {
  return {
    allowCommit: gitPermissions.allow_commit === true || gitPermissions.allowCommit === true,
    allowPush: gitPermissions.allow_push === true || gitPermissions.allowPush === true,
    allowedBranch: String(gitPermissions.allowed_branch || gitPermissions.allowedBranch || 'main')
  };
}

function commitAndPush({
  repoPath,
  gitCommand,
  branch,
  commitMessage,
  allowCommit,
  allowPush
}) {
  const command = ensureGitCommand(gitCommand);
  const meta = verifyPreconditions(repoPath, command);
  const current = meta.branch;
  const targetBranch = branch || current;

  const status = getStatus(repoPath, command);
  if (!status.ok) {
    throw new Error(`GIT_STATUS_FAILED: ${status.stderr || status.stdout}`);
  }

  if (!hasChanges(status.stdout)) {
    return { changed: false, committed: false, pushed: false, branch: current, reason: 'NO_CHANGES' };
  }

  if (!allowCommit) {
    return { changed: true, committed: false, pushed: false, branch: current, reason: 'GIT_COMMIT_NOT_ALLOWED' };
  }

  if (hasEnvFile(status.stdout)) {
    throw new Error('GIT_REFUSES_ENV_FILE');
  }

  const changedFiles = parseStatusFiles(status.stdout).map(normalizeRepoRelative).filter(Boolean);
  const add = run(command, ['add', '--', ...changedFiles], { cwd: repoPath });
  if (!add.ok) throw new Error(`GIT_ADD_FAILED: ${add.stderr || add.stdout}`);

  const commit = run(command, ['commit', '-m', commitMessage], { cwd: repoPath });
  if (!commit.ok) throw new Error(`GIT_COMMIT_FAILED: ${commit.stderr || commit.stdout}`);

  const sha = run(command, ['rev-parse', 'HEAD'], { cwd: repoPath });
  if (!sha.ok) throw new Error(`GIT_SHA_FAILED: ${sha.stderr || sha.stdout}`);

  if (!allowPush) {
    return {
      changed: true,
      committed: true,
      pushed: false,
      commit_sha: sha.stdout,
      sha: sha.stdout,
      branch: current,
      reason: 'GIT_PUSH_NOT_ALLOWED'
    };
  }

  if (current !== targetBranch) {
    return {
      changed: true,
      committed: true,
      pushed: false,
      commit_sha: sha.stdout,
      sha: sha.stdout,
      branch: current,
      reason: 'GIT_BRANCH_NOT_ALLOWED'
    };
  }

  const push = run(command, ['push', 'origin', `HEAD:${targetBranch}`], { cwd: repoPath });
  if (!push.ok) throw new Error(`GIT_PUSH_FAILED: ${push.stderr || push.stdout}`);

  return {
    changed: true,
    committed: true,
    pushed: true,
    commit_sha: sha.stdout,
    sha: sha.stdout,
    branch: current
  };
}

function normalizeRepoRelative(file) {
  return String(file || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function allowedSet(allowedFiles = []) {
  return new Set((allowedFiles || []).map(normalizeRepoRelative).filter(Boolean));
}

function envFiles(files = []) {
  return files.filter((file) => {
    const name = path.basename(normalizeRepoRelative(file)).toLowerCase();
    return name === '.env' || name.startsWith('.env.');
  });
}

function classifyGitFailure(command, detail) {
  const text = `${command || ''}\n${detail || ''}`.toLowerCase();
  if (/non-fast-forward|fetch first|stale info|rejected|failed to push some refs|remote contains work/.test(text)) {
    return { action: 'BLOCKED', reason: 'GIT_REMOTE_DIVERGED', checkpoint_type: null };
  }
  if (/permission denied|access denied|repository not found|not have permission|write access|protected branch|403|authorization failed/.test(text)) {
    return { action: 'NEED_HUMAN_ACTION', reason: 'GIT_REMOTE_PERMISSION', checkpoint_type: 'GIT_REMOTE_PERMISSION' };
  }
  if (/authentication failed|could not read username|terminal prompts disabled|credential|login|sign in|publickey|permission denied \(publickey\)|invalid username or password/.test(text)) {
    return { action: 'NEED_HUMAN_ACTION', reason: 'GIT_AUTH', checkpoint_type: 'GIT_AUTH' };
  }
  return { action: 'BLOCKED', reason: 'GIT_COMMAND_FAILED', checkpoint_type: null };
}

function changedPathsForValidation(statusText) {
  return parseStatusEntries(statusText)
    .flatMap((entry) => entry.paths)
    .map(normalizeRepoRelative)
    .filter(Boolean);
}

function stagedPaths(statusText) {
  return parseStatusEntries(statusText)
    .filter((entry) => entry.staged)
    .flatMap((entry) => entry.paths)
    .map(normalizeRepoRelative)
    .filter(Boolean);
}

function safeFailure(reason, extra = {}) {
  return {
    changed: true,
    committed: false,
    pushed: false,
    commit_sha: null,
    sha: null,
    status: 'BLOCKED',
    classification: 'BLOCKED',
    reason,
    ...extra
  };
}

function sameSet(left, right) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((item) => rightSet.has(item));
}

function humanActionFailure(reason, checkpointType, extra = {}) {
  return {
    changed: true,
    committed: false,
    pushed: false,
    commit_sha: null,
    sha: null,
    status: 'NEED_HUMAN_ACTION',
    classification: 'NEED_HUMAN_ACTION',
    reason,
    checkpoint: {
      checkpoint_type: checkpointType,
      requirement_type: checkpointType,
      human_action_request: reason === 'GIT_AUTH'
        ? 'Git authentication is required before Autopilot can stage and push this milestone.'
        : 'Git remote permission is required before Autopilot can push this milestone.',
      user_action: reason === 'GIT_AUTH'
        ? 'Sign in or configure Git credentials for the authorized repository, then resume.'
        : 'Grant repository or branch permission for the configured Git identity, then resume.',
      action_location: 'git_remote',
      validation_method: 'manual_confirmation',
      paused_from_phase: 'GIT_STAGE',
      resume_phase: 'GIT_STAGE'
    },
    ...extra
  };
}

function headSha(repoPath, command, commandRunner = run) {
  const sha = commandRunner(command, ['rev-parse', 'HEAD'], { cwd: repoPath });
  if (!sha.ok) throw new Error(`GIT_SHA_FAILED: ${sha.stderr || sha.stdout}`);
  return sha.stdout;
}

function runSafeGitStage({
  repoPath,
  gitPermissions,
  missionId,
  roadmapId,
  milestoneId,
  attempt,
  objective,
  allowedFiles,
  gitCommand,
  priorResult,
  commandRunner = run
}) {
  const permissions = normalizePermissions(gitPermissions);
  let command;
  try {
    command = ensureGitCommand(gitCommand);
  } catch (error) {
    return humanActionFailure('GIT_AUTH', 'GIT_AUTH', { error: String(error.message || error) });
  }
  const branch = permissions.allowedBranch;
  const commitMessage = commitMessageFor({ missionId, roadmapId, milestoneId, attempt, objective });

  const priorCommitSha = priorResult?.commit_sha || priorResult?.sha || null;
  const priorSucceeded = String(priorResult?.status || priorResult?.classification || '').toUpperCase() === 'SUCCESS';
  if (priorSucceeded && (priorResult.reason === 'NO_CHANGES' || (priorCommitSha && priorResult.pushed === true))) {
    return { ...priorResult, changed: priorResult.changed === true, committed: priorResult.committed === true, pushed: priorResult.pushed === true, status: 'SUCCESS', classification: 'SUCCESS', reason: priorResult.reason || null };
  }

  let meta;
  try {
    meta = verifyPreconditions(repoPath, command, commandRunner);
  } catch (error) {
    const reason = String(error.message || error).includes('GIT_COMMAND_NOT_FOUND') ? 'GIT_COMMAND_NOT_FOUND' : String(error.message || error).split(':')[0];
    return reason === 'GIT_COMMAND_NOT_FOUND'
      ? humanActionFailure('GIT_AUTH', 'GIT_AUTH', { error: reason, target_branch: branch })
      : safeFailure(reason, { error: String(error.message || error), target_branch: branch });
  }

  const current = meta.branch;
  const allowed = allowedSet(allowedFiles);
  const allowedSnapshot = [...allowed];
  const evidenceBase = {
    allowed_files: allowedSnapshot,
    commit_message: commitMessage,
    timestamp: new Date().toISOString(),
    attempt: Number(attempt || 1),
    mission_id: missionId || null,
    roadmap_id: roadmapId || null,
    milestone_id: milestoneId || null
  };
  const invalidAllowed = envFiles([...allowed]);
  if (allowed.size === 0) return safeFailure('GIT_INVALID_ALLOWLIST', { branch: current, target_branch: branch });
  if (invalidAllowed.length) return safeFailure('GIT_REFUSES_ENV_FILE', { branch: current, target_branch: branch, unauthorized_files: invalidAllowed });

  const status = getStatus(repoPath, command, commandRunner);
  if (!status.ok) return safeFailure('GIT_STATUS_FAILED', { branch: current, target_branch: branch, error: status.stderr || status.stdout });

  const changedFiles = [...new Set(changedPathsForValidation(status.stdout))];
  const preStaged = [...new Set(stagedPaths(status.stdout))];
  if (envFiles(changedFiles).length) {
    return safeFailure('GIT_REFUSES_ENV_FILE', { branch: current, target_branch: branch, changed_files: changedFiles, unauthorized_files: envFiles(changedFiles) });
  }
  const unauthorized = changedFiles.filter((file) => !allowed.has(file));
  const unauthorizedStaged = preStaged.filter((file) => !allowed.has(file));
  if (unauthorizedStaged.length) {
    return safeFailure('GIT_UNAUTHORIZED_STAGED_PATHS', { branch: current, target_branch: branch, changed_files: changedFiles, staged_files: preStaged, unauthorized_files: unauthorizedStaged });
  }
  if (unauthorized.length) {
    return safeFailure('GIT_UNAUTHORIZED_DIRTY_PATHS', { branch: current, target_branch: branch, changed_files: changedFiles, unauthorized_files: unauthorized });
  }
  if (!changedFiles.length && !priorCommitSha) {
    return { changed: false, committed: false, pushed: false, branch: current, target_branch: branch, status: 'SUCCESS', classification: 'SUCCESS', reason: 'NO_CHANGES', changed_files: [], staged_files: [], ...evidenceBase, completed_at: new Date().toISOString() };
  }
  if (!permissions.allowCommit) {
    return humanActionFailure('GIT_COMMIT_NOT_ALLOWED', 'GIT_REMOTE_PERMISSION', { branch: current, target_branch: branch, changed_files: changedFiles });
  }

  let commitSha = priorCommitSha;
  let committed = Boolean(commitSha);
  let staged = Array.isArray(priorResult?.staged_files)
    ? priorResult.staged_files.map(normalizeRepoRelative).filter(Boolean)
    : preStaged;
  if (!commitSha) {
    const changedAllowedFiles = changedFiles.filter((file) => allowed.has(file));
    const add = commandRunner(command, ['add', '--', ...changedAllowedFiles], { cwd: repoPath });
    if (!add.ok) {
      const classified = classifyGitFailure('git add', add.stderr || add.stdout);
      return classified.action === 'NEED_HUMAN_ACTION'
        ? humanActionFailure(classified.reason, classified.checkpoint_type, { branch: current, target_branch: branch, changed_files: changedFiles, error: add.stderr || add.stdout })
        : safeFailure(classified.reason, { branch: current, target_branch: branch, changed_files: changedFiles, error: add.stderr || add.stdout });
    }

    const cached = commandRunner(command, ['diff', '--cached', '--name-only'], { cwd: repoPath });
    if (!cached.ok) return safeFailure('GIT_CACHED_DIFF_FAILED', { branch: current, target_branch: branch, changed_files: changedFiles, error: cached.stderr || cached.stdout });
    staged = cached.stdout.split(/\r?\n/).map(normalizeRepoRelative).filter(Boolean);
    const unauthorizedCached = staged.filter((file) => !allowed.has(file));
    if (unauthorizedCached.length) {
      return safeFailure('GIT_UNAUTHORIZED_STAGED_PATHS', { branch: current, target_branch: branch, changed_files: changedFiles, staged_files: staged, unauthorized_files: unauthorizedCached });
    }
    if (!sameSet(staged, changedAllowedFiles)) {
      return safeFailure('GIT_STAGED_SCOPE_MISMATCH', { branch: current, target_branch: branch, changed_files: changedFiles, staged_files: staged, expected_staged_files: changedAllowedFiles });
    }
    const commit = commandRunner(command, ['commit', '-m', commitMessage], { cwd: repoPath });
    if (!commit.ok) {
      const classified = classifyGitFailure('git commit', commit.stderr || commit.stdout);
      return classified.action === 'NEED_HUMAN_ACTION'
        ? humanActionFailure(classified.reason, classified.checkpoint_type, { branch: current, target_branch: branch, changed_files: changedFiles, staged_files: staged, error: commit.stderr || commit.stdout })
        : safeFailure(classified.reason, { branch: current, target_branch: branch, changed_files: changedFiles, staged_files: staged, error: commit.stderr || commit.stdout });
    }
    commitSha = headSha(repoPath, command, commandRunner);
    committed = true;
  }

  if (!permissions.allowPush) {
    return { changed: true, committed, pushed: false, commit_sha: commitSha, sha: commitSha, branch: current, target_branch: branch, status: 'SUCCESS', classification: 'SUCCESS', reason: 'GIT_PUSH_NOT_ALLOWED', changed_files: changedFiles, staged_files: staged, ...evidenceBase, committed_at: new Date().toISOString() };
  }
  if (current !== branch) {
    return safeFailure('GIT_BRANCH_NOT_ALLOWED', { branch: current, target_branch: branch, changed_files: changedFiles, staged_files: staged, commit_sha: commitSha, sha: commitSha, committed });
  }
  const push = commandRunner(command, ['push', 'origin', `HEAD:${branch}`], { cwd: repoPath });
  if (!push.ok) {
    const classified = classifyGitFailure('git push', push.stderr || push.stdout);
    return classified.action === 'NEED_HUMAN_ACTION'
      ? humanActionFailure(classified.reason, classified.checkpoint_type, { branch: current, target_branch: branch, changed_files: changedFiles, staged_files: staged, commit_sha: commitSha, sha: commitSha, committed, error: push.stderr || push.stdout })
      : safeFailure(classified.reason, { branch: current, target_branch: branch, changed_files: changedFiles, staged_files: staged, commit_sha: commitSha, sha: commitSha, committed, error: push.stderr || push.stdout });
  }

  return { changed: true, committed: true, pushed: true, commit_sha: commitSha, sha: commitSha, pushed_sha: commitSha, branch: current, target_branch: branch, status: 'SUCCESS', classification: 'SUCCESS', reason: null, changed_files: changedFiles, staged_files: staged, ...evidenceBase, pushed_at: new Date().toISOString() };
}

function runGitFlow({ repoPath, gitPermissions, missionId, objective, gitCommand, allowedFiles, roadmapId, milestoneId, attempt, priorResult, safeStage }) {
  if (safeStage === true) {
    return runSafeGitStage({
      repoPath,
      gitPermissions,
      missionId,
      roadmapId,
      milestoneId,
      attempt,
      objective,
      allowedFiles,
      gitCommand,
      priorResult
    });
  }
  const permissions = normalizePermissions(gitPermissions);
  const command = ensureGitCommand(gitCommand);
  const branch = permissions.allowedBranch;

  return commitAndPush({
    repoPath,
    gitCommand: command,
    branch,
    commitMessage: commitMessageFor({ missionId, objective }),
    allowCommit: permissions.allowCommit,
    allowPush: permissions.allowPush
  });
}

function verifyAllowedChanges(statusText, allowedFiles = []) {
  const allowed = allowedSet(allowedFiles);
  const changed = parseStatusFiles(statusText).map(normalizeRepoRelative);
  const unauthorized = changed.filter((file) => !allowed.has(file));
  return { ok: unauthorized.length === 0, changed_files: changed, unauthorized_files: unauthorized };
}

module.exports = {
  run,
  githubDesktopGitCandidates,
  resolveGitCommand,
  verifyPreconditions,
  getStatus,
  hasChanges,
  commitMessageFor,
  normalizePermissions,
  commitAndPush,
  runSafeGitStage,
  runGitFlow,
  parseStatusFiles,
  parseStatusEntries,
  classifyGitFailure,
  verifyAllowedChanges
};
