/**
 * WebMCP readiness scanner.
 *
 * Probes each registry-listed page, discovers its tools via document.modelContext,
 * and checks them against the spec's own stated best practices:
 *   - descriptions must be present and usable
 *   - inputSchema fields must be documented
 *   - required fields must actually be enforced at execution time
 *   - outputSchema must exist  (spec issue #9 - currently impossible, so universal)
 *   - tools must not throw on schema-valid arguments
 *   - tools must be deterministic
 *   - page tool budget must stay small
 *
 * Usage: node scan.mjs [--out results.json] [--delay 250]
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLYFILL = join(__dirname, 'node_modules/@mcp-b/global/dist/index.iife.js');
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 WebMCP-Readiness-Scanner/0.1 (+research scan; contact: local)';

const argOf = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : def;
};
const OUT = argOf('--out', 'scan-results.json');
const CALL_DELAY = Number(argOf('--delay', 250));
const NAV_TIMEOUT = 45000;
const SETTLE = 6000;   // client-side registration finishes after DOMContentLoaded

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Build a schema-valid argument object, plus a deliberately-incomplete one. */
function buildArgs(tool) {
  const props = tool.inputSchema?.properties || {};
  const full = {};
  for (const [k, v] of Object.entries(props)) {
    if (v?.type === 'string') full[k] = v.default ?? v.examples?.[0] ?? (v.enum ? v.enum[0] : 'test');
    else if (v?.type === 'number' || v?.type === 'integer') full[k] = typeof v.default === 'number' ? v.default : 1;
    else if (v?.type === 'boolean') full[k] = false;
    else if (v?.type === 'array') full[k] = [];
    else if (v?.type === 'object') full[k] = {};
  }
  const required = tool.inputSchema?.required || [];
  const partial = {};
  for (const k of required.slice(1)) if (k in full) partial[k] = full[k];
  return { full, partial, missingCount: Math.max(0, required.length - Object.keys(partial).length) };
}

/** Runs inside the page. One tool at a time, wrapped so a throw is data, not a crash. */const inPage = async ({ onlyMissingRequired }) => {
  const out = { ok: null, tools: [], apiPresent: false, error: null };
  try {
    out.apiPresent = !!document.modelContext?.getTools;
    if (!out.apiPresent) { out.error = 'document.modelContext absent'; return out; }
    const tools = await document.modelContext.getTools();
    const wanted = onlyMissingRequired
      ? tools.filter((t) => (t.inputSchema?.required || []).length > 1)
      : tools;
    for (const tool of wanted) {
      const props = tool.inputSchema?.properties || {};
      const full = {};
      for (const [k, v] of Object.entries(props)) {
        if (v?.type === 'string') full[k] = v.default ?? v.examples?.[0] ?? (v.enum ? v.enum[0] : 'test');
        else if (v?.type === 'number' || v?.type === 'integer') full[k] = typeof v.default === 'number' ? v.default : 1;
        else if (v?.type === 'boolean') full[k] = false;
        else if (v?.type === 'array') full[k] = [];
        else if (v?.type === 'object') full[k] = {};
      }
      const required = tool.inputSchema?.required || [];
      const partial = {};
      for (const k of required.slice(1)) if (k in full) partial[k] = full[k];
      const missing = Math.max(0, required.length - Object.keys(partial).length);

      const call = async (args) => {
        try {
          return { ok: true, value: JSON.stringify(await document.modelContext.executeTool(tool, JSON.stringify(args))) };
        } catch (e) {
          return { ok: false, value: `${e.name}: ${e.message}`.slice(0, 160) };
        }
      };

      const a = await call(full);
      const b = await call(full);
      const partialRes = missing > 0 ? await call(partial) : null;

      out.tools.push({
        name: tool.name || null,
        description: tool.description || '',
        inputSchema: tool.inputSchema || null,
        outputSchema: tool.outputSchema ?? null,
        call1: a, call2: b, partialCall: partialRes, missingRequired: missing
      });
    }
    out.ok = true;
  } catch (e) {
    out.error = e.message.slice(0, 200);
  }
  return out;
};

/**
 * Unwrap the layers of JSON that WebMCP results arrive in.
 *
 * executeTool() returns {content:[{type:"text",text:"..."}]}, and the .text is
 * itself often a JSON string. A probe that stringifies the result once therefore
 * sees \\"isError\\":true and every substring check silently misses. Peel until
 * stable so rule checks run against the real payload.
 */
function unwrap(value) {
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
 * alone does NOT mean the input was accepted. Verified against corpuslaw.us
 * (isError:true) and b2a.bluepillow.com (isError:true) for exactly this case.
 */
function looksLikeRejection(value) {
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

/** Apply the spec rules to a discovered tool. Pure function, no I/O. */
function grade(t, toolBudget) {
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
  if (!t.outputSchema) f.push({ rule: 'output-schema-declared', severity: 'high', note: 'spec issue #9' });

  if (!t.call1.ok) f.push({ rule: 'tolerates-valid-args', severity: 'high', detail: t.call1.value });
  if (t.call1.ok && t.call2.ok && t.call1.value !== t.call2.value) {
    f.push({ rule: 'deterministic', severity: 'medium' });
  }
  if (toolBudget > 15) f.push({ rule: 'tool-budget', severity: 'medium', detail: `${toolBudget} tools registered on this page`, site: true });
  return f;
}

const loadDomains = () => {
  const p = join(__dirname, 'reg-domains.json');
  try { return JSON.parse(readFileSync(p, 'utf8')).results; }
  catch { throw new Error('run fetch-registry.mjs first'); }
};

const browser = await chromium.launch();
const entries = loadDomains();
const results = [];
const started = Date.now();

for (const [i, e] of entries.entries()) {
  const url = e.domain.startsWith('http') ? e.domain : `https://${e.domain}`;
  const rec = {
    entry: e.domain, registryToolCount: e.toolCount ?? null, verified: !!e.verified,
    url, status: null, outcome: 'unknown', toolsObserved: 0, rootRetried: false,
    rootTools: 0, failures: [], error: null, findings: [], toolNames: [], ms: 0
  };
  const t0 = Date.now();

  const attempt = async (target) => {
    const ctx = await browser.newContext({ userAgent: UA });
    await ctx.addInitScript({ path: POLYFILL });
    const page = await ctx.newPage();
    const out = { status: null, data: null, err: null };
    try {
      const resp = await page.goto(target, { waitUntil: 'load', timeout: NAV_TIMEOUT });
      out.status = resp ? resp.status() : null;
      await page.waitForTimeout(SETTLE);
      out.data = await page.evaluate(inPage, { onlyMissingRequired: false });
    } catch (err) {
      out.err = err.message.split('\n')[0].slice(0, 120);
    }
    await ctx.close();
    return out;
  };

  let r = await attempt(url);
  // Transient failures worth retrying: network, and "execution context destroyed"
  // (a race with client-side navigation, not a real verdict on the site).
  const transient = (x) => {
    const e = String(x?.err || x?.data?.error || '');
    return /ERR_NETWORK|ERR_CONNECTION|ERR_TIMED_OUT|Execution context was destroyed|net::/i.test(e);
  };
  for (let a = 1; a < 3 && (transient(r) || (r.data && !r.data.ok && !/absent/i.test(r.data.error || ''))); a++) {
    rec.failures.push({ attempt: a, error: r.err || r.data?.error || 'api-missing' });
    await sleep(2500);
    r = await attempt(url);
  }

  rec.status = r.status;
  rec.error = r.err || r.data?.error || null;
  const tools = r.data?.tools || [];

  if (r.data?.ok && tools.length === 0) {
    // Registry may point at the wrong path - check the site root before judging.
    rec.rootRetried = true;
    const rootUrl = new URL(url).origin;
    const rr = await attempt(rootUrl);
    rec.rootTools = rr.data?.ok ? rr.data.tools.length : 0;
    rec.outcome = rec.rootTools > 0 ? 'listed-at-wrong-path' : 'listed-but-zero-tools';
    if (rec.rootTools > 0) {
      rec.findings.push({ rule: 'registry-path-matches-tool-registration', severity: 'high', detail: `tools live at ${rootUrl}` });
    }
  } else if (r.data?.ok) {
    rec.outcome = 'tools-observable';
  } else {
    rec.outcome = 'unreachable';
  }

  const graded = tools.map((t) => ({ t, f: grade(t, tools.length) }));
  const siteLevel = new Set();
  for (const { t, f } of graded) {
    for (const x of f) {
      if (x.site) {
        if (siteLevel.has(x.rule)) continue;   // page-level rule: report once per page
        siteLevel.add(x.rule);
        rec.findings.push({ ...x });
      } else {
        rec.findings.push({ tool: t.name, ...x });
      }
    }
  }
  rec.toolsObserved = tools.length;
  rec.toolNames = tools.map((t) => t.name);
  rec.ms = Date.now() - t0;
  results.push(rec);

  process.stdout.write(
    `${String(i + 1).padStart(2)}/${entries.length} ${e.domain.slice(0, 44).padEnd(46)} ` +
    `${String(rec.toolsObserved).padStart(3)} tools  ${rec.outcome}\n`
  );
  await sleep(CALL_DELAY);
}

await browser.close();

const byOutcome = {};
for (const r of results) byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;
const byRule = {};
for (const r of results) for (const f of r.findings) byRule[f.rule] = (byRule[f.rule] || 0) + 1;

const payload = {
  scannedAt: new Date().toISOString(),
  durationSec: Math.round((Date.now() - started) / 1000),
  entryCount: entries.length,
  registryToolTotal: entries.reduce((a, e) => a + (e.toolCount || 0), 0),
  toolsObserved: results.reduce((a, r) => a + r.toolsObserved, 0),
  byOutcome, byRule,
  results
};
writeFileSync(join(__dirname, OUT), JSON.stringify(payload, null, 2));

console.log(`\n=== ${payload.entryCount} entries · ${payload.registryToolTotal} registry tools · ${payload.toolsObserved} tools observed · ${payload.durationSec}s`);
console.log('outcomes:', JSON.stringify(byOutcome));
console.log('findings by rule:');
for (const [k, v] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
console.log(`\nwrote ${OUT}`);
