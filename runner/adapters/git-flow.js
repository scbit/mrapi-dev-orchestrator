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
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    error: result.error || null
  };
}

function resolveGitCommand() {
  const probes = process.platform === 'win32'
    ? [
        ['git.exe'],
        ['C:\\Program Files\\Git\\cmd\\git.exe'],
        ['C:\\Program Files\\Git\\bin\\git.exe']
      ]
    : [['git']];

  for (const [command] of probes) {
    const check = run(command, ['--version']);
    if (check.ok) return command;
  }

  return null;
}

function ensureGitCommand(gitCommand) {
  const command = gitCommand || resolveGitCommand();
  if (!command) throw new Error('GIT_COMMAND_NOT_FOUND');
  return command;
}

function getStatus(repoPath, gitCommand) {
  return run(gitCommand, ['status', '--porcelain=v1'], { cwd: repoPath });
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

function hasEnvFile(statusText) {
  return parseStatusFiles(statusText).some((file) => {
    const name = path.basename(file).toLowerCase();
    return name === '.env' || name.startsWith('.env.');
  });
}

function currentBranch(repoPath, gitCommand) {
  const branch = run(gitCommand, ['branch', '--show-current'], { cwd: repoPath });
  if (!branch.ok || !branch.stdout) {
    throw new Error(`GIT_BRANCH_FAILED: ${branch.stderr || branch.stdout}`);
  }
  return branch.stdout;
}

function gitDir(repoPath, gitCommand) {
  const dir = run(gitCommand, ['rev-parse', '--git-dir'], { cwd: repoPath });
  if (!dir.ok || !dir.stdout) {
    throw new Error(`GIT_DIR_FAILED: ${dir.stderr || dir.stdout}`);
  }
  return path.resolve(repoPath, dir.stdout);
}

function verifyPreconditions(repoPath, gitCommand) {
  const tree = run(gitCommand, ['rev-parse', '--is-inside-work-tree'], { cwd: repoPath });
  if (!tree.ok || tree.stdout !== 'true') {
    throw new Error('GIT_NOT_WORK_TREE');
  }

  const dir = gitDir(repoPath, gitCommand);
  const blocked = [
    'MERGE_HEAD',
    'REBASE_HEAD',
    'rebase-apply',
    'rebase-merge'
  ].some((entry) => fs.existsSync(path.join(dir, entry)));
  if (blocked) throw new Error('GIT_UNRESOLVED_MERGE_OR_REBASE');

  return { branch: currentBranch(repoPath, gitCommand), gitDir: dir };
}

function shortObjective(value) {
  return String(value || 'software mission')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 72) || 'software mission';
}

function commitMessageFor({ missionId, objective }) {
  return `MRAPI ${missionId || 'mission'}: ${shortObjective(objective)}`;
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

  const add = run(command, ['add', '--all'], { cwd: repoPath });
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

function runGitFlow({ repoPath, gitPermissions, missionId, objective, gitCommand }) {
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

module.exports = {
  run,
  resolveGitCommand,
  verifyPreconditions,
  getStatus,
  hasChanges,
  commitMessageFor,
  normalizePermissions,
  commitAndPush,
  runGitFlow
};
