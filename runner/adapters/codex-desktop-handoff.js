const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function sanitizeId(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function buildCodexPrompt({ task, executionRun, cfg }) {
  const handoff = task.codex_handoff || executionRun.codex_handoff || null;
  const brainInstructions =
    handoff?.task_spec?.instructions ||
    task.brain_output?.task_spec?.instructions ||
    task.brain_output?.task_spec?.objective ||
    task.brain_output?.objective ||
    task.objective ||
    '';
  const executionRules = handoff?.execution_rules?.length
    ? handoff.execution_rules.map((rule) => `- ${rule}`).join('\n')
    : `- You are the Executor, not the Brain.
- Work only in the local repository shown above.
- Follow the Brain instructions exactly.
- Preserve multi-tenancy and existing functionality.
- Run the requested tests.
- Do not access GCP or Cloud Run.
- Do not deploy.
- Do not run git commit or git push; the Runner owns commit/push after successful Codex execution.
- Runner may commit/push only when trusted MRAPI handoff git_permissions allow it.
- Stop if the Brain stop conditions are met.`;

  return `MRAPI DEV ORCHESTRATOR — CODEX EXECUTION HANDOFF

CONTRACT VERSION
${handoff?.contract_version || 'LEGACY_CODEX_HANDOFF'}

TASK ID
${handoff?.task_id || task.id}

EXECUTION RUN ID
${handoff?.execution_run_id || executionRun.id}

BRAIN RUN ID
${handoff?.brain_run_id || task.brain_run_id || executionRun.brain_run_id || ''}

MISSION ID
${handoff?.mission_id || task.mission_id || ''}

TENANT ID
${handoff?.tenant_id || task.tenant_id || ''}

WORKSPACE ID
${handoff?.workspace_id || task.workspace_id || ''}

PROJECT ID
${handoff?.project_id || task.project_id || ''}

LOCAL REPOSITORY
${handoff?.repository_path || cfg.repoPath}

BRAIN INSTRUCTIONS
${brainInstructions}

EXECUTION CONSTRAINTS
${JSON.stringify(handoff?.execution_constraints || {
  no_gcp: true,
  no_cloud_run: true,
  no_deploy: true,
  deployment: 'HUMAN_MANUAL_DEPLOY'
}, null, 2)}

TRUSTED GIT PERMISSIONS
${JSON.stringify(handoff?.git_permissions || {
  allow_commit: false,
  allow_push: false,
  allowed_branch: 'main'
}, null, 2)}

EXECUTION RULES
${executionRules}

ARTIFACT CONTRACT
- Source code changes stay in the normal repository paths.
- Final user-facing PDF/XLSX/CSV/image/ZIP/dataset deliverables go to .mrapi-artifacts/${sanitizeId(handoff?.task_id || task.id)}/.
- Artifact files must be 10 MB or smaller.
- Do not store generated deliverables directly in Firestore.

RETURN
- changed files
- tests run + results
- success/failure
- concise summary
- HUMAN MANUAL DEPLOY if deployment is required
`;
}

function copyToWindowsClipboard(text) {
  const ps = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$input | Out-String | Set-Clipboard'
    ],
    {
      input: text,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000
    }
  );

  if (ps.error) throw ps.error;
  if (ps.status !== 0) {
    throw new Error(`CLIPBOARD_FAILED: ${ps.stderr || `exit ${ps.status}`}`);
  }
}

function launchConfiguredCodexApp(command) {
  if (!command) return { launched: false, reason: 'MRAPI_CODEX_APP_COMMAND_NOT_SET' };

  // The command is explicitly provided by the operator. We do not guess an
  // installed-app identifier or hardcode ChatGPT/Codex paths.
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-Command', command],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    }
  );
  child.unref();
  return { launched: true };
}

function prepareCodexDesktopHandoff({ task, executionRun, cfg }) {
  const prompt = buildCodexPrompt({ task, executionRun, cfg });

  fs.mkdirSync(cfg.codexHandoffDir, { recursive: true });

  const filename = [
    new Date().toISOString().replace(/[:.]/g, '-'),
    sanitizeId(task.id),
    sanitizeId(executionRun.id)
  ].join('_') + '.txt';

  const handoffPath = path.join(cfg.codexHandoffDir, filename);
  fs.writeFileSync(handoffPath, prompt, 'utf8');

  let clipboard = { copied: false };
  if (cfg.codexAutoClipboard) {
    copyToWindowsClipboard(prompt);
    clipboard = { copied: true };
  }

  const app = launchConfiguredCodexApp(cfg.codexAppCommand);

  return {
    prompt,
    handoffPath,
    clipboard,
    app
  };
}

module.exports = {
  buildCodexPrompt,
  prepareCodexDesktopHandoff
};
