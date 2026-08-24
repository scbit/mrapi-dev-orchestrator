const { chromium } = require('playwright-core');

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
  const loginControls = page.locator('a[href*="/auth/login"], button:has-text("Log in"), button:has-text("Sign up")');
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

async function waitForAssistantCompletion(page, previousText, timeoutMs) {
  const started = Date.now();
  let detectedText = '';
  let lastText = '';
  let stableSince = 0;

  console.log('[BRAIN WEB] waiting for assistant response');

  // First detect a genuinely new/changed assistant response.
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

  if (!detectedText) {
    throw new Error('CHATGPT_RESPONSE_NOT_DETECTED');
  }

  // Then wait until generation stops and the response text briefly settles.
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
    await page.goto(chatUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
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

    const outputText = await waitForAssistantCompletion(
      page,
      previousText,
      cfg.brainTimeoutMs
    );

    if (onProgress) await onProgress(95, 'Brain plan received');

    return {
      outputText,
      chatUrl: page.url()
    };
  } finally {
    await context.close();
  }
}

module.exports = { runChatGPTWeb, isChatGPTLoginPage };
