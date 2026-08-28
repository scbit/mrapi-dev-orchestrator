const { chromium } = require('playwright-core');
const {
  hasValidAutopilotProgramControl,
  hasValidAutopilotDecision
} = require('../lib/autopilot-contract');

async function getLastAssistantText(page) {
  const messages = page.locator('[data-message-author-role="assistant"]');
  const count = await messages.count();
  if (!count) return '';
  return (await messages.nth(count - 1).innerText()).trim();
}

async function isAssistantGenerating(page) {
  return await page.locator('[data-testid="stop-button"]').count() > 0;
}

async function isChatGPTLoginPage(page) {
  const url = page.url();
  if (/chatgpt\.com\/(auth\/login|login|auth)/i.test(url)) return true;
  const loginControls = page.locator(
    'a[href*="/auth/login"], button:has-text("Log in"), button:has-text("Sign up")'
  );
  if (await loginControls.count() > 0) return true;
  if (typeof page.getByText === 'function') {
    return await page.getByText(/Log in to ChatGPT|Sign up to ChatGPT/i).count() > 0;
  }
  return false;
}

async function assertLoggedIn(page) {
  if (await isChatGPTLoginPage(page)) {
    const error = new Error('CHATGPT_LOGIN_REQUIRED');
    error.waiting = true;
    throw error;
  }
}

function trustedExecutorRequired(run) {
  const value = run?.brain_context?.current_milestone?.executor_required;
  return typeof value === 'boolean' ? value : null;
}

async function waitForAssistantCompletion(page, previousText, timeoutMs) {
  const started = Date.now();
  let detectedText = '';
  let lastText = '';
  let stableSince = 0;

  console.log('[BRAIN WEB] waiting for assistant response');

  while (Date.now() - started < timeoutMs) {
    await assertLoggedIn(page);
    const text = await getLastAssistantText(page);
    if (text && text !== previousText) {
      detectedText = text;
      lastText = text;
      stableSince = Date.now();
      console.log('[BRAIN WEB] assistant response detected');
      break;
    }
    await page.waitForTimeout(750);
  }

  if (!detectedText) throw new Error('CHATGPT_RESPONSE_NOT_DETECTED');

  while (Date.now() - started < timeoutMs) {
    await assertLoggedIn(page);
    const text = await getLastAssistantText(page);
    if (text && text !== lastText) {
      lastText = text;
      stableSince = Date.now();
    }

    const unchangedFor = (Date.now() - stableSince) / 1000;
    if (lastText && unchangedFor >= 2 && !(await isAssistantGenerating(page))) {
      console.log('[BRAIN WEB] assistant response stable');
      return lastText;
    }
    await page.waitForTimeout(750);
  }

  throw new Error('CHATGPT_RESPONSE_TIMEOUT');
}

async function requestExecutorProgramRepair(page, previousText, timeoutMs) {
  const input = page.locator('#prompt-textarea').first();
  await input.waitFor({ state: 'visible', timeout: 60000 });
  await input.click();
  await input.fill(`Your previous AUTOPILOT PROGRAM response is missing or malformed for an executor-required milestone. Do not redesign the milestone and do not add prose. Return ONLY:
<MRAPI_CONTROL>
{
  "requires_execution": true,
  "execution_type": "EXECUTOR",
  "task_spec": {
    "title": "short execution title",
    "objective": "milestone outcome",
    "allowed_files": ["repo-relative/path.ext"],
    "required_tests": ["exact scoped test command"],
    "diagnostic_tests": [],
    "instructions": "exact bounded executor instructions"
  }
}
</MRAPI_CONTROL>
allowed_files and required_tests must be non-empty. Codex is hands only. No deploy.`);
  await input.press('Enter');
  console.log('[BRAIN WEB] executor PROGRAM contract repair requested');
  return waitForAssistantCompletion(page, previousText, timeoutMs);
}

async function requestBrainOnlyProgramRepair(page, previousText, timeoutMs) {
  const input = page.locator('#prompt-textarea').first();
  await input.waitFor({ state: 'visible', timeout: 60000 });
  await input.click();
  await input.fill(`Your previous AUTOPILOT PROGRAM response is missing or malformed for a trusted Brain-only milestone (executor_required=false).

Do NOT create a Task.
Do NOT request Codex or any EXECUTION_RUN.
Do NOT return analysis only.

Return exactly these two blocks:

<MRAPI_CONTROL>
{
  "requires_execution": false,
  "execution_type": "BRAIN_ONLY",
  "task_spec": {}
}
</MRAPI_CONTROL>

<MRAPI_RESULT>
Write the complete final user-facing result for this milestone here.
</MRAPI_RESULT>

MRAPI_RESULT must be non-empty and final. Preserve the same milestone and trusted scope.`);
  await input.press('Enter');
  console.log('[BRAIN WEB] Brain-only PROGRAM contract repair requested');
  return waitForAssistantCompletion(page, previousText, timeoutMs);
}

async function requestAutopilotFormatRepair(page, previousText, timeoutMs) {
  const input = page.locator('#prompt-textarea').first();
  await input.waitFor({ state: 'visible', timeout: 60000 });
  await input.click();
  await input.fill(`Your previous AUTOPILOT VERIFICATION response did not match the required machine-readable contract. Do not re-run Codex. Return ONLY:
<MRAPI_AUTOPILOT>
{
  "action": "COMPLETE",
  "reason": "concise verification reasoning",
  "execution_spec": null
}
</MRAPI_AUTOPILOT>
The action must be COMPLETE, RETRY, BLOCKED, or NEED_HUMAN_ACTION.`);
  await input.press('Enter');
  console.log('[BRAIN WEB] autopilot format repair requested');
  return waitForAssistantCompletion(page, previousText, timeoutMs);
}

async function runChatGPTWeb({ cfg, run, prompt, onProgress }) {
  const workerId = String(run.worker_id || '').toUpperCase();
  const chatUrl = cfg.chatUrlForWorker(workerId);
  const chromeUserDataDir = cfg.chromeUserDataDirForWorker
    ? cfg.chromeUserDataDirForWorker(workerId)
    : cfg.chromeUserDataDir;

  if (onProgress) await onProgress(10, 'Opening dedicated ChatGPT Web worker chat');

  const context = await chromium.launchPersistentContext(chromeUserDataDir, {
    channel: cfg.chromeChannel,
    headless: false,
    viewport: null,
    args: ['--start-maximized']
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await assertLoggedIn(page);

    const input = page.locator('#prompt-textarea').first();
    await input.waitFor({ state: 'visible', timeout: 60000 });
    await assertLoggedIn(page);

    const previousText = await getLastAssistantText(page);

    if (onProgress) await onProgress(20, `Sending mission to ${workerId} Brain`);
    await input.click();
    await input.fill(prompt);
    await input.press('Enter');

    console.log('[BRAIN WEB] prompt sent');

    if (onProgress) await onProgress(35, `Waiting for ${workerId} Brain plan`);

    let outputText = await waitForAssistantCompletion(
      page,
      previousText,
      cfg.brainTimeoutMs
    );

    if (run.autopilot_mode === true && run.autopilot_phase === 'PROGRAM') {
      const executorRequired = trustedExecutorRequired(run);
      if (!hasValidAutopilotProgramControl(outputText, { executorRequired })) {
        if (executorRequired === false) {
          if (onProgress) await onProgress(
            80,
            'Brain-only PROGRAM result invalid; requesting one Brain-only self-repair'
          );
          outputText = await requestBrainOnlyProgramRepair(
            page,
            outputText,
            cfg.brainTimeoutMs
          );
        } else {
          if (onProgress) await onProgress(
            80,
            'Executor PROGRAM contract invalid; requesting one executor self-repair'
          );
          outputText = await requestExecutorProgramRepair(
            page,
            outputText,
            cfg.brainTimeoutMs
          );
        }
      }
    }

    if (
      run.autopilot_phase === 'VERIFY_EXECUTION' &&
      !hasValidAutopilotDecision(outputText)
    ) {
      if (onProgress) await onProgress(
        80,
        'Brain verification format invalid; requesting one self-repair'
      );
      outputText = await requestAutopilotFormatRepair(
        page,
        outputText,
        cfg.brainTimeoutMs
      );
    }

    if (onProgress) await onProgress(95, 'Brain response received');

    return { outputText, chatUrl: page.url() };
  } finally {
    await context.close();
  }
}

module.exports = {
  runChatGPTWeb,
  isChatGPTLoginPage,
  trustedExecutorRequired,
  requestBrainOnlyProgramRepair,
  requestExecutorProgramRepair
};
