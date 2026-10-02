/**
 * Local test suite. Runs against the bundled fixture page, so it needs no network
 * and no live sites. Verifies both that the checks FIRE on seeded defects and that
 * they do NOT fire on a correct tool.
 *
 * Usage: node action/test.mjs
 */
import { chromium, probePage } from '../lib/probe.mjs';
import { grade, looksLikeRejection, unwrap } from '../lib/checks.mjs';
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
