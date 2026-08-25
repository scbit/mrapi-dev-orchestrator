const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBrainResponse } = require('../src/services/orchestration');
const { brainPrompt } = require('../brain-adapter/lib/prompts');

test('autopilot MRAPI_CONTROL preserves Brain-defined allowed_files over adapter fallback', () => {
  const output = `<MRAPI_CONTROL>\n${JSON.stringify({
    requires_execution: true,
    execution_type: 'EXECUTOR',
    task_spec: {
      title: 'Bounded change',
      objective: 'Implement bounded change',
      allowed_files: ['src/services/autopilot.js', 'test/autopilot.test.js'],
      instructions: 'OBJECTIVE\\nImplement bounded change'
    }
  })}\n</MRAPI_CONTROL>`;
  const parsed = parseBrainResponse(output, {
    task_spec: { title: 'legacy fallback', objective: 'legacy', instructions: output }
  });
  assert.equal(parsed.task_spec.title, 'Bounded change');
  assert.deepEqual(parsed.task_spec.allowed_files, ['src/services/autopilot.js', 'test/autopilot.test.js']);
});

test('autopilot PROGRAM prompt includes mandatory allowed_files in returned control shape', () => {
  const prompt = brainPrompt({ worker_id: 'W01', autopilot_mode: true, autopilot_phase: 'PROGRAM', objective: 'MILESTONE: Autopilot Loop' }, { repoPath: 'C:/repo' });
  assert.match(prompt, /task_spec\.allowed_files is REQUIRED/);
  assert.match(prompt, /"allowed_files": \["repo-relative\/path\.ext"\]/);
});
