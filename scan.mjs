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
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, probePage } from './lib/probe.mjs';
import { grade, RULES } from './lib/checks.mjs';

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

  const page = await probePage(browser, url);
  rec.status = page.status;
  rec.error = page.error;
  rec.outcome = page.outcome;
  const tools = page.tools;

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
  rec.toolsObserved = page.tools.length;
  rec.toolNames = page.tools.map((t) => t.name);
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
