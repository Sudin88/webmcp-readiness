/**
 * WebMCP tool checks - shared by the CLI scanner and the GitHub Action.
 *
 * Every rule here is derived from the WebMCP spec's own guidance (Draft Community
 * Group Report, 30 Sep 2026) rather than from opinion. See REPORT.md for the
 * baseline that motivated each one.
 *
 * IMPORTANT: `looksLikeRejection` and `unwrap` exist because of two verified bugs.
 * Do not "simplify" them. See the notes inline and in REPORT.md.
 */

/** Build a schema-valid argument object, plus a deliberately-incomplete one. */
export function buildArgs(tool) {
  const props = tool?.inputSchema?.properties || {};
  const full = {};
  for (const [k, v] of Object.entries(props)) {
    if (v?.type === 'string') full[k] = v.default ?? v.examples?.[0] ?? (v.enum ? v.enum[0] : 'test');
    else if (v?.type === 'number' || v?.type === 'integer') full[k] = typeof v.default === 'number' ? v.default : 1;
    else if (v?.type === 'boolean') full[k] = false;
    else if (v?.type === 'array') full[k] = [];
    else if (v?.type === 'object') full[k] = {};
  }
  const required = tool?.inputSchema?.required || [];
  const partial = {};
  for (const k of required.slice(1)) if (k in full) partial[k] = full[k];
  return {
    full,
    partial,
    missingCount: Math.max(0, required.length - Object.keys(partial).length)
  };
}

/**
 * Unwrap the layers of JSON that WebMCP results arrive in.
 *
 * executeTool() returns {content:[{type:"text",text:"..."}]}, and the .text is
 * itself often a JSON string. A probe that stringifies the result once therefore
 * sees \\"isError\\":true and every substring check silently misses. Peel until
 * stable so rule checks run against the real payload.
 */
export function unwrap(value) {
  let s = value;
  for (let i = 0; i < 5; i++) {
    if (typeof s !== 'string') return s;
    const t = s.trim();
    // A JSON string literal ("...") must be parsed too, otherwise the layer
    // JSON.stringify() added around the tool's own JSON text hides everything.
    if (!t.startsWith('{') && !t.startsWith('[') && !t.startsWith('"')) return s;
    try { s = JSON.parse(t); } catch { return s; }
  }
  return s;
}

/**
 * A tool that correctly refuses a call with missing required fields usually does so
 * in the payload, not by throwing: an MCP-style error result, structuredContent.isError,
 * an {error: ...} body, or an "Error:"/"must be" message. Transport-level success
 * alone does NOT mean the input was accepted.
 *
 * Verified against corpuslaw.us and b2a.bluepillow.com, which both return
 * isError:true for exactly this case. Treating transport success as acceptance
 * produced 67 false positives in the baseline scan (68% of all tools) - all wrong.
 */
export function looksLikeRejection(value) {
  const u = unwrap(value);
  const s = typeof u === 'string' ? u : JSON.stringify(u || '');
  if (!s) return false;
  if (typeof u === 'object' && u !== null) {
    if (u.isError === true) return true;
    if (u.error) return true;
    if (u.ok === false) return true;
    const sc = u.structuredContent;
    if (sc && (sc.isError === true || sc.error)) return true;
    const txt = Array.isArray(u.content)
      ? u.content.filter((c) => c?.type === 'text').map((c) => c.text).join(' ')
      : '';
    if (txt && /\b(error|invalid|required|missing|not found|unsupported)\b/i.test(txt)) return true;
  }
  return /\b(must be|is required|missing|invalid|not found|unsupported|unexpected)\b/i.test(s);
}

export const RULES = {
  'description-present': {
    severity: 'high',
    title: 'Tool has no description',
    why: 'An agent cannot choose a tool it cannot read. The spec requires a description that says what the tool does and when to use it.',
    fix: 'Add a description: what the tool does, and when an agent should prefer it over a similar tool.'
  },
  'description-substantive': {
    severity: 'medium',
    title: 'Tool description is too short to be useful',
    why: 'Descriptions under 20 characters rarely convey when a tool should be used.',
    fix: 'Expand the description and state the distinction from neighbouring tools.'
  },
  'schema-fields-documented': {
    severity: 'medium',
    title: 'Input schema fields are undocumented',
    why: 'The spec says: "Document schemas with descriptions - Provide helpful description fields on all input parameters in inputSchema to help the agent supply appropriate values." Without them the model must guess units and format.',
    fix: 'Add a description to every inputSchema property, including units and accepted formats.'
  },
  'required-fields-enforced': {
    severity: 'high',
    title: 'Tool accepted a call missing a required field',
    why: 'A field listed in inputSchema.required was omitted and the tool still succeeded. The spec says to "validate strictly in code" - a silently accepted incomplete call produces wrong results with no error.',
    fix: 'Validate required fields inside execute() and return an actionable error message.'
  },
  'output-schema-declared': {
    // Deliberately 'info', not 'high'. outputSchema does not exist in the spec yet
    // (open issue #9), so this finding is currently true of 100% of tools on the
    // public web. Failing a build on an unfixable spec gap would make the action
    // useless. It is reported so the gap stays visible, never used to fail CI.
    severity: 'info',
    title: 'Tool declares no output contract',
    why: 'outputSchema does not exist in the spec yet (open issue #9), so nothing validates what a tool returns. Agents must infer the return shape from free text. This is true of every tool in the public registry today and is not fixable by an implementer yet.',
    fix: 'Describe the return shape in the tool description for now, and adopt an outputSchema once the spec lands.'
  },
  'tolerates-valid-args': {
    severity: 'high',
    title: 'Tool threw on input that satisfied its own schema',
    why: 'The probe synthesises arguments strictly from the declared inputSchema. If the call still fails, the schema under-describes the real constraints and an agent has no way to discover the true rule except by failing.',
    fix: 'Align the schema with the implementation, or relax the implementation to match the declared schema.'
  },
  'volatile-response': {
    severity: 'info',
    title: 'Response values differ between identical calls',
    why: 'The response SHAPE is stable, only the values differ - normally a timestamp, request id or other volatile field. Not a defect, reported so a schema-shape check can be distinguished from a data check.',
    fix: 'Nothing to fix. If the varying fields matter, document them in the description.'
  },
  deterministic: {
    severity: 'medium',
    title: 'Tool returned a structurally different response for identical input',
    why: 'Two identical calls returned responses of a different SHAPE, so a caller cannot rely on the declared contract holding between calls.',
    fix: 'Make the response deterministic for a given input, or document the varying fields explicitly.'
  },
  'not-probed': {
    severity: 'info',
    title: 'Tool was discovered but not exercised',
    why: 'The probe found this tool but did not get a chance to call it, so no behavioural verdict was reached.',
    fix: 'Re-run the check; if it persists the page may register tools faster than they can be exercised.'
  },
  'tool-budget': {
    severity: 'medium',
    title: 'Page registers too many tools',
    why: 'The spec warns that every registered tool consumes context, adds latency, and increases tool confusion. Register tools dynamically by page state instead of all at once.',
    fix: 'Register only the tools relevant to the current page state, and unregister them via AbortSignal when no longer applicable.'
  }
};

/**
 * Apply every spec-derived rule to one probed tool.
 * @param {object} t    probed tool record (see probePage)
 * @param {number} toolBudget  how many tools the page registered
 * @returns {Array<{rule:string,severity:string,detail?:string,site?:boolean}>}
 */
/**
 * Structural signature of a tool response: key paths and value TYPES, with
 * scalar values discarded.
 *
 * Why: comparing two raw responses for equality makes almost every live tool look
 * "nondeterministic", because real APIs embed timestamps, request ids and random
 * values. Observed in practice - the determinism check named a different tool on
 * each run of corpuslaw.us, which would churn a baseline on every single run.
 *
 * Comparing SHAPE instead separates the two cases that actually matter:
 *   - same shape, different values  -> volatile data, normal and harmless
 *   - different shape              -> the contract itself changed between calls,
 *                                      which is a real defect
 */
export function shapeOf(value, depth = 0) {
  const u = unwrap(value);
  if (depth > 6) return '~';
  if (u === null) return 'null';
  if (u === undefined) return 'undefined';
  if (Array.isArray(u)) return `[${u.length ? shapeOf(u[0], depth + 1) : ''}]`;
  if (typeof u === 'object') {
    return '{' + Object.keys(u).sort().map((k) => `${k}:${shapeOf(u[k], depth + 1)}`).join(',') + '}';
  }
  if (typeof u === 'number') return Number.isInteger(u) ? 'int' : 'num';
  return typeof u;
}

export function grade(t, toolBudget) {
  const f = [];
  const desc = t.description || '';
  if (!desc) f.push({ rule: 'description-present', severity: 'high' });
  else if (desc.length < 20) f.push({ rule: 'description-substantive', severity: 'medium' });

  const props = t.inputSchema?.properties;
  if (props && Object.keys(props).length) {
    const documented = Object.values(props).filter((p) => p?.description && p.description.length > 3).length;
    if (documented === 0) f.push({ rule: 'schema-fields-documented', severity: 'medium' });
  }
  if (t.missingRequired > 0 && t.partialCall?.ok && !looksLikeRejection(t.partialCall.value)) {
    f.push({ rule: 'required-fields-enforced', severity: 'high' });
  }
  if (!t.outputSchema) f.push({ rule: 'output-schema-declared', severity: 'info', note: 'blocked on spec issue #9' });

  // Defensive: a tool record may arrive without call results (e.g. a partial
  // probe). Never invent a verdict we did not actually observe.
  if (!t.call1) f.push({ rule: 'not-probed', severity: 'info', detail: 'tool discovered but not exercised' });
  else if (!t.call1.ok) f.push({ rule: 'tolerates-valid-args', severity: 'high', detail: t.call1.value });
  if (t.call1?.ok && t.call2?.ok && t.call1.value !== t.call2.value) {
    // Compare shape, not raw text: a differing timestamp is not a broken contract.
    const s1 = shapeOf(t.call1.value);
    const s2 = shapeOf(t.call2.value);
    if (s1 !== s2) f.push({ rule: 'deterministic', severity: 'medium', detail: `shape changed between identical calls: ${s1} vs ${s2}`.slice(0, 160) });
    else f.push({ rule: 'volatile-response', severity: 'info', detail: 'values differ between calls but the response shape is stable' });
  }
  if (toolBudget > 15) f.push({ rule: 'tool-budget', severity: 'medium', detail: `${toolBudget} tools registered on this page`, site: true });
  return f;
}

/** Render one finding as a human sentence, for CLI and Action summaries. */
export function describeFinding(toolName, finding) {
  const meta = RULES[finding.rule] || {};
  const where = toolName ? `\`${toolName}\`` : 'this page';
  let s = `${where}: ${meta.title || finding.rule}`;
  if (finding.detail) s += ` (${finding.detail})`;
  if (meta.why) s += `\n    ${meta.why}`;
  if (meta.fix) s += `\n    fix: ${meta.fix}`;
  return s;
}
