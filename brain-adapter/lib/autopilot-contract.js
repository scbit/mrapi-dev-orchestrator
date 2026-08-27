function normalizeBrainTransportText(text) {
  return String(text || '')
    .replace(/\\([<>_])/g, '$1');
}

function escapeInvalidJsonBackslashes(text) {
  const source = String(text || '');
  let out = '';
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = source[i + 1];
    if (next === undefined) {
      out += '\\\\';
      continue;
    }
    // Preserve valid JSON escapes atomically. This is important for Windows paths
    // already encoded as C:\\\\Users\\\\Shadow: treating the second slash of \\\\ as
    // a new invalid escape would corrupt the JSON into \\\\\\U.
    if ('"\\\\/bfnrtu'.includes(next)) {
      out += ch + next;
      i += 1;
      continue;
    }
    // A single transport backslash before a non-JSON escape (for example \a in
    // test\\autopilot...) must become a literal backslash inside the JSON string.
    out += '\\\\' + next;
    i += 1;
  }
  return out;
}

function parseTaggedJson(text, tag) {
  const normalized = normalizeBrainTransportText(text);
  const match = normalized.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'i'));
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch {}
  try { return JSON.parse(escapeInvalidJsonBackslashes(match[1])); } catch { return null; }
}

function hasValidAutopilotProgramControl(text) {
  const parsed = parseTaggedJson(text, 'MRAPI_CONTROL');
  if (!parsed || parsed.requires_execution !== true) return false;
  const executionType = String(parsed.execution_type || '').toUpperCase();
  if (!['EXECUTOR', 'CODEX'].includes(executionType)) return false;
  const spec = parsed.task_spec && typeof parsed.task_spec === 'object' ? parsed.task_spec : null;
  if (!spec) return false;
  if (!String(spec.instructions || '').trim()) return false;
  const hasAllowedFiles = Array.isArray(spec.allowed_files) && spec.allowed_files.some((item) => String(item || '').trim());
  const hasRequiredTests = Array.isArray(spec.required_tests) && spec.required_tests.some((item) => String(item || '').trim());
  return hasAllowedFiles && hasRequiredTests;
}

function hasValidAutopilotDecision(text) {
  const parsed = parseTaggedJson(text, 'MRAPI_AUTOPILOT');
  return Boolean(parsed && ['COMPLETE', 'RETRY', 'BLOCKED', 'NEED_HUMAN_ACTION'].includes(String(parsed.action || '').toUpperCase()));
}

module.exports = {
  normalizeBrainTransportText,
  escapeInvalidJsonBackslashes,
  parseTaggedJson,
  hasValidAutopilotProgramControl,
  hasValidAutopilotDecision
};
