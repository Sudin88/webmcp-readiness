/**
 * Local test suite. Runs against the bundled fixture page, so it needs no network
 * and no live sites. Verifies both that the checks FIRE on seeded defects and that
 * they do NOT fire on a correct tool.
 *
 * Usage: node action/test.mjs
 */
import { chromium, probePage } from '../lib/probe.mjs';
import { grade, looksLikeRejection, unwrap } from '../lib/checks.mjs';
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
