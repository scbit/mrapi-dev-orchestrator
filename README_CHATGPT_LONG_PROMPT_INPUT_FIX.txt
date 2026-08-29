MRAPI DEV — CHATGPT LONG PROMPT INPUT FIX

CAUSE
W01 Brain Adapter uses locator.fill(prompt) on ChatGPT's ProseMirror composer.
Large Planner prompts can time out with:
locator.fill: Timeout 30000ms exceeded

FIX
- Adds setComposerText()
- Clears with Ctrl+A / Backspace
- Uses page.keyboard.insertText()
- Verifies text reached #prompt-textarea
- Replaces composer input.fill(...) calls

INSTALL
1. Extract over:
   C:\Users\Shadow\Documents\GitHub\mrapi-dev-orchestrator

2. Run:
   node tools\apply-chatgpt-long-prompt-input-fix.js
   node -c brain-adapter\adapters\chatgpt-web.js

Expected:
CHATGPT_LONG_PROMPT_INPUT_FIX_OK

3. Restart:
   START MRAPI W01 + RUNNER

4. Use Retry / Correct Brain on the SAME failed Planner Mission.
