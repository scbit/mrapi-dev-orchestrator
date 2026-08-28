const fs = require('fs');

function patchFile(file, transform, label) {
  let s = fs.readFileSync(file, 'utf8');
  const out = transform(s);
  if (out === s) {
    console.log('[SKIP or pattern not needed]', label);
    return;
  }
  fs.writeFileSync(file, out, 'utf8');
  console.log('[PATCHED]', label);
}

// 1) planner.js: tolerant JSON parser for raw Windows paths inside JSON strings.
patchFile('src/services/planner.js', (s) => {
  if (s.includes('function repairJsonWindowsBackslashes')) return s;

  const anchor = "function parseProposal(input = {}) {";
  if (!s.includes(anchor)) throw new Error('PATCH_PATTERN_NOT_FOUND:parseProposal');

  const helper = `function repairJsonWindowsBackslashes(source) {
  const text = String(source || '');
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }

    if (ch === '"') {
      out += ch;
      inString = false;
      continue;
    }

    if (ch !== '\\\\') {
      out += ch;
      continue;
    }

    const next = text[i + 1] || '';

    // Valid JSON escapes stay untouched.
    if ('"\\\\/bfnrtu'.includes(next)) {
      out += ch;
      escaped = true;
      continue;
    }

    // Raw Windows path separator inside a JSON string.
    // Convert one backslash to an escaped JSON backslash.
    out += '\\\\\\\\';
  }

  return out;
}

`;

  s = s.replace(anchor, helper + anchor);

  const oldCatch = `  try {
    return JSON.parse(jsonText);
  } catch {
    const error = new Error('PLANNER_PROPOSAL_JSON_INVALID');
    error.status = 400;
    throw error;
  }`;

  const newCatch = `  try {
    return JSON.parse(jsonText);
  } catch (firstError) {
    try {
      return JSON.parse(repairJsonWindowsBackslashes(jsonText));
    } catch {
      const error = new Error('PLANNER_PROPOSAL_JSON_INVALID');
      error.status = 400;
      error.cause = firstError;
      throw error;
    }
  }`;

  if (!s.includes(oldCatch)) throw new Error('PATCH_PATTERN_NOT_FOUND:planner JSON catch');
  return s.replace(oldCatch, newCatch);
}, 'planner Windows path JSON repair');

// 2) prompts.js: make the Brain produce strict JSON-safe path strings.
patchFile('brain-adapter/lib/prompts.js', (s) => {
  if (s.includes('JSON SAFETY RULE')) return s;

  const needle = "HARD OUTPUT CONTRACT";
  const idx = s.indexOf(needle);
  if (idx < 0) throw new Error('PATCH_PATTERN_NOT_FOUND:HARD OUTPUT CONTRACT');

  const insert = `JSON SAFETY RULE
- Output MUST be valid JSON parseable by JSON.parse().
- For Windows paths inside JSON strings, use forward slashes (preferred), for example C:/Users/Shadow/Documents/GitHub/repo, OR escape each backslash as \\\\.
- Never emit raw Windows backslashes such as C:\\Users inside a JSON string.

`;
  return s.slice(0, idx) + insert + s.slice(idx);
}, 'Brain strict JSON path rule');

console.log('PLANNER_WINDOWS_PATH_JSON_FIX_OK');
