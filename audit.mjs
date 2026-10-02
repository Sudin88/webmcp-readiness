import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGETS = [
  'https://www.proxy-compare.com',
  'https://corpuslaw.us',
  'https://scvd.store',
  'https://www.taxsaleatlas.com',
  'https://googlechromelabs.github.io/webmcp-tools/demos/coffee-shop',
];

const browser = await chromium.launch();
const rows = [];

for (const url of TARGETS) {
  const ctx = await browser.newContext();
  await ctx.addInitScript({ path: join(__dirname, 'node_modules/@mcp-b/global/dist/index.iife.js') });
  const page = await ctx.newPage();
  const row = { url: url.replace('https://', ''), n: 0, noDesc: 0, noSchemaDesc: 0, noRequired: 0, throws: 0, nondet: 0, verbs: 0 };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);
    const r = await page.evaluate(async () => {
      const t = await document.modelContext.getTools();
      const out = {
        n: t.length, noDesc: 0, noSchemaDesc: 0, noRequired: 0, throws: 0, nondet: 0, verbs: 0,
        schemasWithoutOutput: 0, samples: []
      };
      const VERB = /^(get|list|search|find|create|add|update|delete|remove|set|check|verify|compare|calculate|order|book|submit|fetch|show|cancel|start|track)/i;
      for (const tool of t) {
        if (!tool.description || tool.description.length < 20) out.noDesc++;
        if (VERB.test(tool.name || '')) out.verbs++;
        const props = tool.inputSchema?.properties;
        if (props && Object.keys(props).length) {
          const described = Object.values(props).filter((p) => p && p.description && p.description.length > 3).length;
          if (described === 0) out.noSchemaDesc++;
        }
        // spec: outputSchema does not exist yet (issue #9) -> every tool is unverified on output
        if (!tool.outputSchema) out.schemasWithoutOutput++;
        // determinism: call twice with minimal args
        const args = {};
        for (const [k, v] of Object.entries(props || {})) {
          if (v?.type === 'string') args[k] = v.default ?? v.examples?.[0] ?? (v.enum ? v.enum[0] : 'test');
          else if (v?.type === 'number' || v?.type === 'integer') args[k] = 1;
          else if (v?.type === 'boolean') args[k] = false;
        }
        const call = async () => {
          try {
            const res = await document.modelContext.executeTool(tool, JSON.stringify(args));
            return JSON.stringify(res);
          } catch (e) { return `__THROW__${e.name}`; }
        };
        const a = await call();
        const b = await call();
        if (String(a).startsWith('__THROW__')) out.throws++;
        else if (a !== b) out.nondet++;
        if (out.samples.length < 2) out.samples.push({ name: tool.name, args, a: String(a).slice(0, 90) });
      }
      return out;
    });
    Object.assign(row, r);
    row.samples = r.samples;
  } catch (e) { row.error = e.message.split('\n')[0].slice(0, 70); }
  if (row.error) console.log('  !! ERROR on', row.url, '->', row.error);
  rows.push(row);
  await ctx.close();
}
await browser.close();

console.log('SITE'.padEnd(46), 'TOOLS', 'noDesc', 'noSchDesc', 'noOutputSchema', 'THROWS', 'NONDET');
for (const r of rows) {
  console.log(
    r.url.slice(0, 44).padEnd(46),
    String(r.n).padEnd(5), String(r.noDesc).padEnd(6), String(r.noSchemaDesc).padEnd(9),
    String(r.schemasWithoutOutput).padEnd(14), String(r.throws).padEnd(6), r.nondet
  );
}
const T = rows.reduce((a, r) => a + r.n, 0);
const D = rows.reduce((a, r) => a + (r.noDesc || 0), 0);
const S = rows.reduce((a, r) => a + (r.noSchemaDesc || 0), 0);
const O = rows.reduce((a, r) => a + (r.schemasWithoutOutput || 0), 0);
const TH = rows.reduce((a, r) => a + (r.throws || 0), 0);
const ND = rows.reduce((a, r) => a + (r.nondet || 0), 0);
console.log(`\nTOTAL tools=${T} | missing description=${D} (${Math.round(D/T*100)}%) | no schema field docs=${S} (${Math.round(S/T*100)}%) | no outputSchema=${O} (${Math.round(O/T*100)}%) | threw on valid-schema args=${TH} (${Math.round(TH/T*100)}%) | nondeterministic=${ND} (${Math.round(ND/T*100)}%)`);
for (const r of rows) for (const s of (r.samples || [])) console.log(`  e.g. ${r.url} :: ${s.name}(${JSON.stringify(s.args)}) -> ${s.a}`);
