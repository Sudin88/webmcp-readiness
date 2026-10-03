/**
 * Local test suite. Runs against the bundled fixture page, so it needs no network
 * and no live sites. Verifies both that the checks FIRE on seeded defects and that
 * they do NOT fire on a correct tool.
 *
 * Usage: node action/test.mjs
 */
import { chromium, probePage } from '../lib/probe.mjs';
import { grade, looksLikeRejection, unwrap, shapeOf } from '../lib/checks.mjs';
import { toBaseline, diffReport, summarise, baselineUpdateWarning, findingKey } from '../lib/diff.mjs';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
};

console.log('\nunit: rejection detection (the 67-false-positive bug)');
ok(looksLikeRejection('"{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"api error\\"}],\\"isError\\":true}"'), 'escaped isError (the encoding bug)');
ok(looksLikeRejection('{"content":[{"type":"text","text":"Error: x"}],"structuredContent":{"isError":true}}'), 'structuredContent.isError');
ok(looksLikeRejection('{"content":[{"type":"text","text":"{\\"error\\":\\"not_found\\"}"}]}'), 'nested {"error": ...} body');
ok(looksLikeRejection('{"ok":false,"error":"unsupported_browser"}'), 'ok:false payload');
ok(!looksLikeRejection('{"content":[{"type":"text","text":"Subscribed test@test.com"}]}'), 'genuine accept NOT flagged');
ok(!looksLikeRejection('{"content":[{"type":"text","text":"{\\"orderId\\":\\"A-1\\"}"}]}'), 'genuine accept with JSON body NOT flagged');

console.log('\nunit: unwrap peels layers');
ok(unwrap('"\\"{\\\\\\"a\\\\\\":1}\\""') !== undefined, 'unwrap returns a value');
ok(JSON.stringify(unwrap('"{\\"a\\":1}"')) === '{"a":1}', 'single quote-layer peeled');

console.log('\nintegration: probe the seeded fixture page');
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(readFileSync(join(__dirname, '../fixture/index.html')));
});
await new Promise((r) => server.listen(4598, r));
const browser = await chromium.launch();
const page = await probePage(browser, 'http://127.0.0.1:4598/');
await browser.close();
server.close();

ok(page.outcome === 'tools-observable', `discovered tools (got: ${page.outcome})`);
ok(page.tools.length >= 34, `found all seeded tools (got ${page.tools.length})`);

const findingsFor = (name) => {
  const t = page.tools.find((x) => x.name === name);
  if (!t) return null;
  return grade(t, page.tools.length).map((f) => f.rule);
};
const byTool = {};
for (const t of page.tools) byTool[t.name] = grade(t, page.tools.length).map((f) => f.rule);

// The honest tool must produce no ACTIONABLE per-tool finding. It will still show
// the unfixable output-schema gap (info) and the page-level tool-budget rule.
const actionable = (name) =>
  (byTool[name] || []).filter((r) => !['output-schema-declared', 'tool-budget'].includes(r));
ok(actionable('subscribe').length === 0,
  `honest tool: no actionable findings (got: ${actionable('subscribe').join(', ') || 'none'})`);

ok((byTool['place-order'] || []).includes('deterministic'),
  'stateful-lie tool: nondeterminism detected');
ok((byTool['divide'] || []).length >= 1, 'divide tool: at least the output-contract finding');
ok((byTool['create-profile'] || []).includes('required-fields-enforced'),
  'no-validation tool: required field accepted when missing');
ok(page.tools.length > 15, 'tool-budget: page over the budget is flagged');

// ---------------------------------------------------------------- baseline diff
console.log('\nunit: shape-based determinism (a timestamp is not a broken contract)');
const asCall = (o) => JSON.stringify(JSON.stringify(o));
const wrap = (t) => ({ content: [{ type: 'text', text: t }] });
const vol1 = asCall(wrap(JSON.stringify({ id: 'a1', ts: '2026-01-01' })));
const vol2 = asCall(wrap(JSON.stringify({ id: 'a2', ts: '2026-06-06' })));
const broken = asCall(wrap('null'));
ok(vol1 !== vol2, 'the two volatile responses really do differ as raw text');
ok(shapeOf(vol1) === shapeOf(vol2), 'volatile values share a shape -> not flagged as a defect');
ok(shapeOf(vol1) !== shapeOf(broken), 'a structurally different response IS flagged');
const detTool = { name: 't', description: 'x'.repeat(30), inputSchema: { type: 'object', properties: {} },
                  outputSchema: null, missingRequired: 0, call1: { ok: true, value: vol1 }, call2: { ok: true, value: vol2 } };
const detRules = grade(detTool, 1).map((f) => f.rule);
ok(!detRules.includes('deterministic'), 'volatile response does NOT fire the deterministic rule');
ok(detRules.includes('volatile-response'), 'volatile response is reported as info instead');
const brkTool = { ...detTool, call2: { ok: true, value: broken } };
ok(grade(brkTool, 1).map((f) => f.rule).includes('deterministic'), 'changed shape DOES fire the deterministic rule');

console.log('\nunit: baseline diffing');

const reportOf = (findings, tools = []) => ({
  checkedAt: '2026-10-02T00:00:00.000Z',
  results: [{
    url: 'https://a.example', outcome: 'tools-observable',
    tools: tools.map((n) => ({ name: n })),
    findings
  }]
});

const base = toBaseline(reportOf(
  [
    { rule: 'tolerates-valid-args', severity: 'high', tool: 'old_broken' },
    { rule: 'schema-fields-documented', severity: 'medium', tool: 'legacy' }
  ],
  ['good_tool', 'old_broken']
), { note: 'initial' });

ok(base.version === 1, 'baseline carries a version');
ok(base.findings.length === 2, 'baseline stored both findings');
ok(base.tools.length === 2, 'baseline stored both tools');

const d1 = diffReport(reportOf(
  [
    { rule: 'tolerates-valid-args', severity: 'high', tool: 'old_broken' },
    { rule: 'schema-fields-documented', severity: 'medium', tool: 'legacy' },
    { rule: 'tolerates-valid-args', severity: 'high', tool: 'newly_broken' }
  ],
  ['good_tool', 'old_broken', 'newly_broken']
), base);
ok(d1.newFindings.length === 1, `one NEW finding (got ${d1.newFindings.length})`);
ok(d1.newFindings[0].tool === 'newly_broken', 'the new finding is the new one');
ok(d1.knownFindings.length === 2, `two KNOWN findings (got ${d1.knownFindings.length})`);
ok(summarise(d1).newHigh === 1, 'one new HIGH severity');

const d2 = diffReport(reportOf(
  [
    { rule: 'tolerates-valid-args', severity: 'high', tool: 'newly_broken' }
  ],
  ['newly_broken']
), base);
ok(d2.fixedFindings.length === 2, `two FIXED findings (got ${d2.fixedFindings.length})`);
ok(d2.regressions.length === 2, `two REGRESSIONS - both baseline tools removed (got ${d2.regressions.length})`);
ok(d2.regressions.map((r) => r.tool).includes('good_tool'), 'a removed healthy tool is flagged as a regression');

const d3 = diffReport(reportOf(
  [{ rule: 'tolerates-valid-args', severity: 'high', tool: 'old_broken' },
   { rule: 'schema-fields-documented', severity: 'medium', tool: 'legacy' }],
  ['good_tool', 'old_broken']
), base);
ok(d3.newFindings.length === 0 && d3.fixedFindings.length === 0 && d3.regressions.length === 0,
  'identical re-scan produces an empty diff (stable keys, no churn)');

const d4 = diffReport(reportOf([{ rule: 'not-probed', severity: 'info', tool: 'flaky' }], ['x']), null);
ok(d4.newFindings.length === 0, 'not-probed is never treated as a finding');
ok(baselineUpdateWarning({ ...d1, newFindings: Array.from({ length: 40 }, (_, i) => ({ severity: 'high', rule: 'r', url: 'u', tool: 't' + i })), regressions: [] }).length > 0,
  'warns when a baseline would absorb 40 new high findings');
ok(baselineUpdateWarning(d2).some((w) => /regression/i.test(w)),
  'warns when tools vanished');
ok(findingKey({ url: 'u', tool: 't', rule: 'r' }) === 'u|t|r', 'finding key is stable');

console.log('\nunit: a finding\'s own evidence must survive the response mapping');
// Regression: RULES has a `why` (the generic explanation) and grade() emits a
// `detail` (that finding's own evidence). A spread of RULES after the finding
// silently overwrote the evidence, so every rendered report showed the same
// paragraph and none of the actual error text - "Invalid providerSlugs" and
// friends - which are the only actionable strings in the report.
{
  const { RULES } = await import('../lib/checks.mjs');
  const rule = 'tolerates-valid-args';
  const meta = RULES[rule];
  ok(typeof meta.why === 'string' && meta.why.length > 20, `${rule} has an explanation in .why`);
  ok(!('detail' in meta), `${rule} no longer uses .detail (the colliding name)`);

  const finding = {
    rule,
    tool: 'read_site_guide',
    severity: 'high',
    detail: 'Invalid path; see the tool input schema.'
  };
  // The mapping the server performs, mirroring server/scan.mjs.
  const mapped = {
    ...finding,
    title: meta.title || finding.rule,
    explanation: meta.why || '',
    detail: finding.detail ?? ''
  };
  ok(mapped.detail === 'Invalid path; see the tool input schema.',
     'the finding keeps its own evidence after mapping');
  ok(mapped.explanation !== mapped.detail,
     'explanation and evidence are separate fields, so neither overwrites the other');
  ok(mapped.title === meta.title, 'the human title survives');
}

// Every rule must use the non-colliding shape, or a future rule reintroduces
// the bug. Checked as a set so one bad rule fails the suite.
{
  const { RULES } = await import('../lib/checks.mjs');
  const offenders = Object.entries(RULES)
    .filter(([, m]) => 'detail' in m)
    .map(([k]) => k);
  ok(offenders.length === 0, `no rule uses the colliding "detail" key${offenders.length ? ': ' + offenders.join(', ') : ''}`);

  // And the severity vocabulary stays closed, so the UI's colour mapping is safe.
  const sevs = new Set(Object.values(RULES).map((m) => m.severity));
  const bad = [...sevs].filter((x) => !['high', 'medium', 'info'].includes(x));
  ok(bad.length === 0, `severities are within {high,medium,info}${bad.length ? ': ' + bad.join(', ') : ''}`);

  const noTitle = Object.entries(RULES).filter(([, m]) => !m.title || !m.why).map(([k]) => k);
  ok(noTitle.length === 0, `every rule has a title and an explanation${noTitle.length ? ': ' + noTitle.join(', ') : ''}`);
}

console.log('\nparity: EXECUTING the real probe, not a hand-fed synthetic result');
// The previous parity tests passed synthetic objects straight into grade(), so they
// never executed probeBody. Five mutations survived the whole suite, including
// reverting each of the bugs they claimed to cover. These run the real serialised
// probe against a real page, in a real browser, in both configurations.
{
  const { chromium, runProbe, CLI_TOOL_TIMEOUT_MS } = await import('../lib/probe.mjs');
  const { grade } = await import('../lib/checks.mjs');
  const http = await import('node:http');

  // A page that games the probe the way the review demonstrated: overriding Math.max
  // suppresses required-fields-enforced and made the Action exit 0 "passed".
  const html = (flags) => `<!doctype html><html><body><script>
    window.__ready = (async () => {
      ${flags.tamper ? 'Math.max = () => 0; Promise.race = (a) => a[0];' : ''}
      await document.modelContext.registerTool({
        name: 'single_required',
        description: 'One required field, accepts an incomplete call.',
        inputSchema: { type:'object', properties:{ email:{type:'string'} }, required:['email'] },
        async execute(args){ return { content:[{type:'text',text:'accepted:'+JSON.stringify(args)}] }; }
      });
      await document.modelContext.registerTool({
        name: 'boom',
        description: 'Always throws on schema-valid input.',
        inputSchema: { type:'object', properties:{ x:{type:'string'} }, required:['x'] },
        async execute(){ throw new Error('Invalid x; see the tool input schema.'); }
      });
      // Crosses a real macrotask, so a 0ms cap would break it. This is what caught
      // the silent re-introduction of the timeout bug.
      await document.modelContext.registerTool({
        name: 'slow_async',
        description: 'Resolves after a real delay, not synchronously.',
        inputSchema: { type:'object', properties:{ y:{type:'string'} }, required:['y'] },
        async execute(){ await new Promise(r => setTimeout(r, 40)); return { content:[{type:'text',text:'ok'}] }; }
      });
      // Far past any per-response cap, so the payload budget is exercised.
      await document.modelContext.registerTool({
        name: 'huge',
        description: 'Returns a very large payload.',
        inputSchema: { type:'object', properties:{ z:{type:'string'} }, required:['z'] },
        async execute(){ return { content:[{type:'text',text:'A'.repeat(200000)}] }; }
      });
      // Never settles. Must become tool-slow / not-probed, never a HIGH verdict.
      // Omitted for the uncapped-config run, which would otherwise wait forever -
      // which is precisely why the CLI passes a real timeout.
      if (!window.__NOHANG__) await document.modelContext.registerTool({
        name: 'hangs',
        description: 'Never resolves.',
        inputSchema: { type:'object', properties:{ w:{type:'string'} }, required:['w'] },
        async execute(){ await new Promise(() => {}); return { content:[{type:'text',text:'never'}] }; }
      });
      return true;
    })();
  </script></body></html>`;

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html({ tamper: req.url.includes('tamper'), nohang: req.url.includes('nohang') }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
  const rulesFor = async (path, cfg) => {
    const ctx = await browser.newContext();
    const { POLYFILL } = await import('../lib/probe.mjs');
    await ctx.addInitScript({ path: POLYFILL });
    const page = await ctx.newPage();
    await page.addInitScript({ content: `window.__NOHANG__=${path.includes('nohang')};` });
    await page.goto(base + path, { waitUntil: 'load' });
    await page.evaluate(() => window.__ready);
    const data = await runProbe(page, cfg);
    await ctx.close();
    const tools = {};
    for (const t of data.tools || []) {
      tools[t.name] = grade(t, (data.tools || []).length).map((f) => f.rule).sort().join(',');
    }
    return { error: data.error, tools, names: (data.tools || []).map((t) => t.name) };
  };

  const cli = await rulesFor('/clean', { toolTimeoutMs: CLI_TOOL_TIMEOUT_MS });
  const srv = await rulesFor('/clean', { toolTimeoutMs: 5000 });
  const tampered = await rulesFor('/tamper', { toolTimeoutMs: CLI_TOOL_TIMEOUT_MS });
  // toolTimeoutMs: 0 MUST mean uncapped. setTimeout(0) is a macrotask, so treating
  // it as a real cap silently disables three rules for any async tool - the exact
  // bug that was reintroduced once already.
  const uncapped = await rulesFor('/nohang', { toolTimeoutMs: 0 });
  // Raw probe data, to assert the payload bound itself rather than only the flag.
  const rawOf = async (path, cfg) => {
    const ctx = await browser.newContext();
    const { POLYFILL } = await import('../lib/probe.mjs');
    await ctx.addInitScript({ path: POLYFILL });
    const page = await ctx.newPage();
    await page.addInitScript({ content: `window.__NOHANG__=${path.includes('nohang')};` });
    await page.goto(base + path, { waitUntil: 'load' });
    await page.evaluate(() => window.__ready);
    const data = await runProbe(page, cfg);
    await ctx.close();
    return data;
  };
  const raw = await rawOf('/clean', { toolTimeoutMs: CLI_TOOL_TIMEOUT_MS });

  ok((cli.tools.single_required || '').includes('required-fields-enforced'),
     'a tool with ONE required field that accepts a bad call IS reported');
  ok((cli.tools.boom || '').includes('tolerates-valid-args'),
     'a tool that genuinely throws on schema-valid input IS reported');
  ok(JSON.stringify(cli.tools) === JSON.stringify(srv.tools),
     'CLI and hosted configurations reach identical verdicts');
  ok(cli.error === null, 'a clean page probes without error');

  // The tamper must be refused, never silently graded.
  // Must require the canary specifically. The weaker OR form passed even with the
  // canary deleted, because the tamper suppresses the finding on its own - so the
  // assertion could never fail.
  ok(tampered.error === 'probe_tampered_math',
     `a page that overrides Math.max is REFUSED, not graded (error=${tampered.error})`);

  // A hanging tool must never produce a HIGH verdict on any path.
  const hang = (cli.tools.hangs || '') + (srv.tools.hangs || '');
  ok(hang.includes('tool-slow') || hang.includes('not-probed'),
     `a never-settling tool is reported as unknown (got: ${hang || 'none'})`);
  ok(!hang.includes('tolerates-valid-args'),
     'a never-settling tool NEVER produces a tolerates-valid-args high finding');

  // The oversized tool must be capped and flagged, not silently truncated.
  ok((cli.tools.huge || '').includes('not-probed'),
     `an oversized response is flagged rather than silently truncated (got: ${cli.tools.huge || 'none'})`);

  ok(!(uncapped.tools.slow_async || '').includes('tolerates-valid-args')
     && !(uncapped.tools.slow_async || '').includes('tool-slow'),
     `toolTimeoutMs:0 means UNCAPPED, so an async tool is neither broken nor slow (got: ${uncapped.tools.slow_async || 'none'})`);

  // Assert the bound itself, not just the `truncated` flag: dropping the slice
  // while keeping the flag would still pass a flag-only assertion.
  const hugeTool = (raw.tools || []).find((t) => t.name === 'huge');
  const hugeLen = hugeTool ? String(hugeTool.call1?.value || '').length : 0;
  ok(hugeTool && hugeTool.call1?.truncated === true && hugeLen > 0 && hugeLen <= 65536,
     `an oversized response is CAPPED at 64 KiB (len=${hugeLen}, truncated=${hugeTool?.call1?.truncated})`);

  // The async tool is what a 0ms cap would break: it crosses a real macrotask.
  ok(!(cli.tools.slow_async || '').includes('tolerates-valid-args'),
     `an async tool is not misread as broken (got: ${cli.tools.slow_async || 'none'})`);

  await browser.close();
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
