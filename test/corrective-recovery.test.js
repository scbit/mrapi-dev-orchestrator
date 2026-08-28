const test = require('node:test');
const assert = require('node:assert/strict');

const {
  defaultCorrectionInstruction,
  buildCorrectiveRecoveryContext,
  correctiveObjective
} = require('../src/services/correctiveRecovery');

test('BRAIN_RESULT_MISSING gets explicit correction', () => {
  const text = defaultCorrectionInstruction('BRAIN_RESULT_MISSING');
  assert.match(text, /BRAIN_RESULT_MISSING/);
  assert.match(text, /complete final Brain result/i);
  assert.match(text, /Brain-only/i);
});

test('recovery context carries prior failure and prior output', () => {
  const context = buildCorrectiveRecoveryContext({
    mission: {
      retry_count: 1,
      blocker_message: 'missing final',
      brain_context: { instructions: ['original rule'] }
    },
    latestBrain: {
      id: 'br-old',
      attempt: 1,
      output_text: 'analysis only'
    },
    failureCode: 'BRAIN_RESULT_MISSING',
    manualInstruction: ''
  });

  assert.equal(context.recovery.previous_brain_run_id, 'br-old');
  assert.equal(context.recovery.previous_output_excerpt, 'analysis only');
  assert.equal(context.recovery.failure_code, 'BRAIN_RESULT_MISSING');
  assert.ok(context.instructions.some((x) => x === 'original rule'));
});

test('operator instruction is preserved separately', () => {
  const context = buildCorrectiveRecoveryContext({
    mission: { brain_context: {} },
    latestBrain: { id: 'br1' },
    failureCode: 'BRAIN_RESULT_MISSING',
    manualInstruction: 'Do not create a Task; return the Brain-only final result.'
  });

  assert.equal(
    context.recovery.operator_instruction,
    'Do not create a Task; return the Brain-only final result.'
  );
  assert.ok(context.instructions.some((x) => /OPERATOR RECOVERY INSTRUCTION/.test(x)));
});

test('corrective objective keeps original objective and adds recovery', () => {
  const context = buildCorrectiveRecoveryContext({
    mission: { brain_context: {} },
    latestBrain: { id: 'br1' },
    failureCode: 'BRAIN_RESULT_MISSING',
    manualInstruction: ''
  });
  const objective = correctiveObjective('ORIGINAL OBJECTIVE', context);
  assert.match(objective, /ORIGINAL OBJECTIVE/);
  assert.match(objective, /RECOVERY CORRECTION/);
  assert.match(objective, /BRAIN_RESULT_MISSING/);
});
