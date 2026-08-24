const { chromium } = require('playwright-core');

async function waitForAssistantCompletion(page, previousCount, timeoutMs) {
  const selector = '[data-message-author-role="assistant"]';

  await page.waitForFunction(
    ({ selector, previousCount }) =>
      document.querySelectorAll(selector).length > previousCount,
    { selector, previousCount },
    { timeout: timeoutMs }
  );

  const started = Date.now();
  let lastText = '';
  let unchangedFor = 0;

  while (Date.now() - started < timeoutMs) {
    const messages = page.locator(selector);
    const count = await messages.count();
    const text = count
      ? (await messages.nth(count - 1).innerText()).trim()
      : '';

    const stopButtons = page.locator(
      'button[aria-label*="Stop"], button[data-testid="stop-button"]'
    );
    const stopVisible = await stopButtons.count()
      ? await stopButtons.first().isVisible().catch(() => false)
      : false;

    if (text && text === lastText) {
      unchangedFor += 1;
    } else {
      lastText = text;
      unchangedFor = 0;
    }

    // ChatGPT UI changes frequently. Accept completion when:
    // 1) we have assistant text,
    // 2) the stop-generating control is gone,
    // 3) text has been unchanged for at least 2 polling cycles.
    if (text && !stopVisible && unchangedFor >= 2) {
      await page.waitForTimeout(1500);
      return text;
    }

    await page.waitForTimeout(1000);
  }

  throw new Error('CHATGPT_RESPONSE_TIMEOUT');
}

async function runChatGPTWeb({ cfg, run, prompt, onProgress }) {
  const chatUrl = run.worker_id === 'W01' ? cfg.brainChatUrlW01 : '';
  if (!chatUrl) throw new Error(`BRAIN_CHAT_URL_MISSING_FOR_${run.worker_id}`);

  if (onProgress) await onProgress(10, 'Opening dedicated ChatGPT Web worker chat');

  const context = await chromium.launchPersistentContext(cfg.chromeUserDataDir, {
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

    const input = page.locator('#prompt-textarea').first();
    await input.waitFor({ state: 'visible', timeout: 60000 });

    const previousCount = await page
      .locator('[data-message-author-role="assistant"]')
      .count();

    if (onProgress) await onProgress(20, 'Sending mission to W01 Brain');

    await input.click();
    await input.fill(prompt);
    await input.press('Enter');

    if (onProgress) await onProgress(35, 'Waiting for W01 Brain plan');

    const outputText = await waitForAssistantCompletion(
      page,
      previousCount,
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

module.exports = { runChatGPTWeb };
