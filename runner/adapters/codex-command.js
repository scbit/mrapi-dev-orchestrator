const { spawn, spawnSync } = require('child_process');

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

async function runCodexCommand({ cfg, prompt, onOutput, onProgress }) {
  const resolved = resolveCommand(cfg);
  if (!resolved) throw new Error('CODEX_COMMAND_NOT_FOUND');

  if (onProgress) await onProgress(5, 'Starting Codex executor');

  return new Promise((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args || [], {
      cwd: cfg.repoPath,
      shell: resolved.shell,
      windowsHide: false,
      env: process.env
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
      reject(error);
    });

    child.on('close', async (code) => {
      clearTimeout(timer);
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

module.exports = { runCodexCommand, resolveCommand };
