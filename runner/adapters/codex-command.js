const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function commandExists(command) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(probe, [command], { encoding: 'utf8' }).status === 0;
}

function resolveCommand(cfg) {
  if (cfg.codexCommand) {
    return {
      shell: true,
      command: cfg.codexCommand,
      args: []
    };
  }

  if (process.platform === 'win32' && commandExists('codex.cmd')) {
    // npm global .cmd shims are most reliable via cmd.exe on Windows.
    return {
      shell: false,
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'codex.cmd', 'exec', '-']
    };
  }

  if (commandExists('codex')) {
    return {
      shell: false,
      command: 'codex',
      args: ['exec', '-']
    };
  }

  return null;
}

function realGitCommand() {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(probe, [process.platform === 'win32' ? 'git.exe' : 'git'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return String(result.stdout || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || null;
}

function createGitReadOnlyGuard(baseEnv = process.env) {
  const realGit = realGitCommand();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrapi-git-guard-'));
  const allowed = ['status', 'diff', 'rev-parse', 'ls-files', 'log', 'show'];

  if (process.platform === 'win32') {
    const target = path.join(dir, 'git.cmd');
    const lines = [
      '@echo off',
      'setlocal',
      'set "MRAPI_GIT_SUBCOMMAND=%~1"',
      ...allowed.map((cmd) => `if /I "%MRAPI_GIT_SUBCOMMAND%"=="${cmd}" goto allow`),
      'echo MRAPI_GIT_WRITE_BLOCKED: Git write/network operations are disabled during Autopilot PROGRAM/RETRY. 1>&2',
      'exit /b 73',
      ':allow',
      realGit ? `"${realGit}" %*` : 'echo MRAPI_GIT_READ_UNAVAILABLE 1>&2 & exit /b 74'
    ];
    fs.writeFileSync(target, lines.join('\r\n'), 'utf8');
  } else {
    const target = path.join(dir, 'git');
    const cases = allowed.join('|');
    const script = `#!/bin/sh\ncase "$1" in\n  ${cases}) ${realGit ? `exec "${realGit}" "$@"` : 'echo MRAPI_GIT_READ_UNAVAILABLE >&2; exit 74'} ;;\n  *) echo MRAPI_GIT_WRITE_BLOCKED: Git write/network operations are disabled during Autopilot PROGRAM/RETRY. >&2; exit 73 ;;\nesac\n`;
    fs.writeFileSync(target, script, { encoding: 'utf8', mode: 0o755 });
  }

  return {
    env: { ...baseEnv, PATH: `${dir}${path.delimiter}${baseEnv.PATH || ''}` },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    dir,
    realGit
  };
}

async function runCodexCommand({ cfg, prompt, onOutput, onProgress, guardGitWrites = false }) {
  const resolved = resolveCommand(cfg);
  if (!resolved) throw new Error('CODEX_COMMAND_NOT_FOUND');

  if (onProgress) await onProgress(5, 'Starting Codex executor');

  const gitGuard = guardGitWrites ? createGitReadOnlyGuard(process.env) : null;

  return new Promise((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args || [], {
      cwd: cfg.repoPath,
      shell: resolved.shell,
      windowsHide: false,
      env: gitGuard?.env || process.env
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, cfg.codexTimeoutMs);

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (onOutput) onOutput(text, 'stdout');
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (onOutput) onOutput(text, 'stderr');
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      gitGuard?.cleanup();
      reject(error);
    });

    child.on('close', async (code) => {
      clearTimeout(timer);
      gitGuard?.cleanup();
      if (timedOut) return reject(new Error('CODEX_TIMEOUT'));
      if (onProgress) await onProgress(95, `Codex exited with code ${code}`);
      resolve({
        success: code === 0,
        exitCode: code,
        stdout,
        stderr
      });
    });

    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

module.exports = { runCodexCommand, resolveCommand, createGitReadOnlyGuard, realGitCommand };
