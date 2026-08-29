const fs = require('fs');

const file = 'brain-adapter/adapters/chatgpt-web.js';
let s = fs.readFileSync(file, 'utf8');

if (!s.includes('async function setComposerText(')) {
  const anchor = 'async function getLastAssistantText(page) {';
  if (!s.includes(anchor)) throw new Error('PATCH_PATTERN_NOT_FOUND:getLastAssistantText');

  const helper = `async function setComposerText(page, input, text) {
  const value = String(text ?? '');

  await input.waitFor({ state: 'visible', timeout: 60000 });
  await input.click();

  // ChatGPT uses a ProseMirror contenteditable composer. locator.fill()
  // can time out on large prompts. Chromium insertText is more reliable.
  await input.press('Control+A');
  await input.press('Backspace');
  await page.keyboard.insertText(value);

  await page.waitForFunction(
    ({ selector, minLength }) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      const current = String(el.innerText || el.textContent || '');
      return current.length >= minLength;
    },
    {
      selector: '#prompt-textarea',
      minLength: Math.max(1, Math.min(value.length, 64))
    },
    { timeout: 15000 }
  );
}

`;
  s = s.replace(anchor, helper + anchor);
}

s = s.replaceAll('await input.fill(prompt);', 'await setComposerText(page, input, prompt);');
s = s.replaceAll('await input.fill(`', 'await setComposerText(page, input, `');

if (s.includes('input.fill(')) {
  throw new Error('UNPATCHED_INPUT_FILL_REMAINS');
}

fs.writeFileSync(file, s, 'utf8');
console.log('CHATGPT_LONG_PROMPT_INPUT_FIX_OK');
