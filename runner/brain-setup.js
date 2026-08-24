const { chromium } = require('playwright-core');
const { cfg } = require('./lib/config');

async function main() {
  console.log('[MRAPI BRAIN SETUP] Dedicated Chrome profile opening.');
  console.log('Log into ChatGPT, create/open W01 dedicated chat, copy its URL, then close Chrome.');

  const context = await chromium.launchPersistentContext(cfg.chromeUserDataDir, {
    channel: cfg.chromeChannel,
    headless: false,
    viewport: null,
    args: ['--start-maximized']
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise((resolve) => context.on('close', resolve));
}

main().catch((error) => {
  console.error('[MRAPI BRAIN SETUP ERROR]', error.message);
  process.exit(1);
});
