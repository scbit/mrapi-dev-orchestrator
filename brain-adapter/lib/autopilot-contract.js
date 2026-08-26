function parseTaggedJson(text, tag) {
  const match = String(text || '').match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'i'));
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function hasValidAutopilotProgramControl(text) {
  const parsed = parseTaggedJson(text, 'MRAPI_CONTROL');
  if (!parsed || parsed.requires_execution !== true) return false;
  const executionType = String(parsed.execution_type || '').toUpperCase();
  if (!['EXECUTOR', 'CODEX'].includes(executionType)) return false;
  const spec = parsed.task_spec && typeof parsed.task_spec === 'object' ? parsed.task_spec : null;
  if (!spec) return false;
  if (!String(spec.instructions || '').trim()) return false;
  return Array.isArray(spec.allowed_files) && spec.allowed_files.some((item) => String(item || '').trim());
}

function hasValidAutopilotDecision(text) {
  const parsed = parseTaggedJson(text, 'MRAPI_AUTOPILOT');
  return Boolean(parsed && ['COMPLETE', 'RETRY', 'BLOCKED'].includes(String(parsed.action || '').toUpperCase()));
}

module.exports = { parseTaggedJson, hasValidAutopilotProgramControl, hasValidAutopilotDecision };
