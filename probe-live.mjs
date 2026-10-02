import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TARGETS = [
  'https://googlechromelabs.github.io/webmcp-tools/demos/pizza-maker',
  'https://googlechromelabs.github.io/webmcp-tools/demos/coffee-shop',
  'https://www.proxy-compare.com',
  'https://corpuslaw.us',
  'https://simpletoolstack.com',
  'https://www.bestprice.gr',
  'https://scvd.store',
  'https://www.taxsaleatlas.com',
];

const browser = await chromium.launch();
const results = [];

for (const url of TARGETS) {
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 WebMCP-Readiness-Probe/0.1' });
  await ctx.addInitScript({ path: join(__dirname, 'node_modules/@mcp-b/global/dist/index.iife.js') });
  const page = await ctx.newPage();
  const rec = { url, status: null, tools: [], error: null, verdict: null, ms: 0 };
  const t0 = Date.now();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    rec.status = resp ? resp.status() : null;
    await page.waitForTimeout(4000);
    const discovered = await page.evaluate(async () => {
      if (!document.modelContext?.getTools) return null;
      const t = await document.modelContext.getTools();
      return t.map((x) => ({ name: x.name, desc: (x.description || '').length }));
    }).catch(() => null);
    if (discovered === null) { rec.verdict = 'no-modelContext'; }
    else if (discovered.length === 0) { rec.verdict = 'registered-in-registry-but-zero-tools-observable'; }
    else {
      rec.tools = discovered;
      rec.verdict = 'tools-observable';
    }
  } catch (e) {
    rec.error = e.message.split('\n')[0].slice(0, 120);
    rec.verdict = 'load-failed';
  }
  rec.ms = Date.now() - t0;
  results.push(rec);
  await ctx.close();
}

await browser.close();

console.log('URL'.padEnd(62), 'HTTP', 'VERDICT', 'TOOLS', 'MS');
for (const r of results) {
  console.log(
    r.url.slice(0, 60).padEnd(62),
    String(r.status).padEnd(4),
    (r.verdict || '').padEnd(48),
    String(r.tools.length).padEnd(5),
    r.ms
  );
}
const obs = results.filter((r) => r.verdict === 'tools-observable').length;
const zero = results.filter((r) => r.verdict === 'registered-in-registry-but-zero-tools-observable').length;
const fail = results.filter((r) => r.verdict === 'load-failed').length;
const none = results.filter((r) => r.verdict === 'no-modelContext').length;
console.log(`\nsummary: ${obs} observable · ${zero} registry-listed-but-zero-tools · ${fail} load-failed · ${none} no-api`);
