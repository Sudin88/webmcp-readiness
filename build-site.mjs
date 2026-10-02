/**
 * Build the public report site from scan-results.json.
 * Static HTML, no framework, no build step beyond this script.
 *
 * Usage: node build-site.mjs [--in scan-results.json] [--out site]
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES } from './lib/checks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argOf = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const IN = argOf('--in', 'scan-results.json');
const OUT = argOf('--out', 'site');

const data = JSON.parse(readFileSync(join(__dirname, IN), 'utf8'));
const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const when = new Date(data.scannedAt);
const dateStr = when.toISOString().slice(0, 10);

const allFindings = data.results.flatMap((r) => r.findings.map((f) => ({ ...f, url: r.url, entry: r.entry })));
const toolsFound = data.results.reduce((a, r) => a + r.toolsObserved, 0);
const sitesWithTools = data.results.filter((r) => r.toolsObserved > 0).length;

const CSS = `
:root{--bg:#0d0f14;--panel:#151922;--line:#242a36;--fg:#e6e9ef;--dim:#9aa4b8;--hi:#ff6b6b;--med:#ffc857;--info:#5b9dd9;--ok:#4ec9a4;--accent:#a78bfa}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding:40px 20px 80px}
h1{font-size:30px;line-height:1.25;margin:0 0 8px;letter-spacing:-.02em}
h2{font-size:20px;margin:44px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--line)}
h3{font-size:16px;margin:24px 0 8px}
a{color:var(--accent)}
.sub{color:var(--dim);margin:0 0 28px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:24px 0 8px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card .n{font-size:26px;font-weight:650;letter-spacing:-.02em}
.card .l{color:var(--dim);font-size:12.5px;margin-top:2px}
.card.hi .n{color:var(--hi)} .card.med .n{color:var(--med)} .card.info .n{color:var(--info)} .card.ok .n{color:var(--ok)}
table{width:100%;border-collapse:collapse;margin:14px 0;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:600;font-size:12.5px;text-transform:uppercase;letter-spacing:.04em}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.pill{display:inline-block;padding:1px 7px;border-radius:5px;font-size:11.5px;font-weight:600;letter-spacing:.02em}
.p-hi{background:rgba(255,107,107,.14);color:var(--hi)}
.p-med{background:rgba(255,200,87,.14);color:var(--med)}
.p-info{background:rgba(91,157,217,.14);color:var(--info)}
.p-ok{background:rgba(78,201,164,.14);color:var(--ok)}
.muted{color:var(--dim)}
.box{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;padding:14px 16px;margin:18px 0}
.box.warn{border-left-color:var(--med)} .box.bad{border-left-color:var(--hi)}
.finding{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:10px 0}
.finding .t{font-weight:600;margin-bottom:4px}
.finding .d{color:var(--dim);font-size:13.5px}
.finding .f{color:var(--dim);font-size:13px;margin-top:6px}
.finding .f b{color:var(--fg);font-weight:600}
footer{margin-top:56px;padding-top:20px;border-top:1px solid var(--line);color:var(--dim);font-size:13px}
.bar{display:flex;height:8px;border-radius:4px;overflow:hidden;margin:10px 0 4px;background:var(--line)}
.bar i{display:block;height:100%}
details{margin:8px 0} summary{cursor:pointer;color:var(--dim)}
`;

// ---------------------------------------------------------------- index
const highCount = allFindings.filter((f) => f.severity === 'high').length;
const medCount = allFindings.filter((f) => f.severity === 'medium').length;
const infoCount = allFindings.filter((f) => f.severity === 'info').length;
const noOutput = allFindings.filter((f) => f.rule === 'output-schema-declared').length;
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

const indexHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>State of the Agent-Readable Web - ${esc(dateStr)}</title>
<meta name="description" content="Independent verification of the public WebMCP registry: ${toolsFound} tools observed, ${pct(noOutput, toolsFound)}% declare no output contract.">
<style>${CSS}</style></head><body><div class="wrap">
<h1>State of the Agent-Readable Web</h1>
<p class="sub">WebMCP Draft Community Group Report, 30 Sep 2026 &middot; scanned ${esc(dateStr)} &middot; ${esc(data.entryCount)} registry entries</p>

<div class="box">
  <strong>${toolsFound} WebMCP tools observed across ${sitesWithTools} sites.</strong>
  <strong>${pct(noOutput, toolsFound)}% of them declare no output contract at all</strong> &mdash;
  and they cannot, because <code>outputSchema</code> does not exist in the spec yet.
  Nothing on the public web lets an agent verify what a tool returns.
</div>

<div class="cards">
  <div class="card"><div class="n">${toolsFound}</div><div class="l">tools observed</div></div>
  <div class="card"><div class="n" style="color:var(--info)">${pct(noOutput, toolsFound)}%</div><div class="l">no output contract</div></div>
  <div class="card med"><div class="n">${medCount}</div><div class="l">medium findings</div></div>
  <div class="card"><div class="n">${data.registryToolTotal - toolsFound}</div><div class="l">claimed but not observed</div></div>
</div>

<h2>What we checked</h2>
<p>Every rule comes from the spec's own guidance, not from opinion. Tools are discovered via
<code>document.modelContext.getTools()</code> and called with arguments synthesised strictly
from their declared <code>inputSchema</code>, twice, so the response can be compared against what
the tool claimed.</p>
<table>
<tr><th>Rule</th><th>Severity</th><th>Findings</th><th>What it means</th></tr>
${Object.entries(data.byRule).map(([rule, n]) => {
  const m = RULES[rule] || { severity: 'medium', detail: '' };
  return `<tr><td style="white-space:nowrap"><code>${esc(rule)}</code></td><td><span class="pill p-${m.severity === 'high' ? 'hi' : m.severity === 'info' ? 'info' : 'med'}">${esc(m.severity)}</span></td><td class="mono" style="white-space:nowrap">${n}</td><td class="muted">${esc(m.detail || '')}</td></tr>`;
}).join('\n')}
</table>

<h2>Registry entries that list tools that are not there</h2>
<table>
<tr><th>Entry</th><th>Claims</th><th>Observed</th><th>State</th></tr>
${data.results.filter((r) => r.outcome !== 'tools-observable').map((r) => `<tr>
<td><code>${esc(r.entry)}</code></td><td class="mono">${r.registryToolCount ?? '?'}</td>
<td class="mono">${r.toolsObserved}</td>
<td><span class="pill p-${r.outcome === 'unreachable' ? 'med' : 'hi'}">${esc(r.outcome)}</span></td></tr>`).join('\n')}
</table>
<p class="muted">An agent visiting one of these pages finds nothing to call. No tool in the current
chain would ever notice.</p>

<h2>Every site, every tool</h2>
<table>
<tr><th>Entry</th><th>Tools</th><th>High</th><th>Medium</th><th>Outcome</th></tr>
${data.results.map((r) => {
  const h = r.findings.filter((f) => f.severity === 'high').length;
  const m = r.findings.filter((f) => f.severity === 'medium').length;
  return `<tr><td><code>${esc(r.entry)}</code></td><td class="mono">${r.toolsObserved}</td>
<td class="mono">${h ? `<span class="pill p-hi">${h}</span>` : '<span class="muted">0</span>'}</td>
<td class="mono">${m || '<span class="muted">0</span>'}</td>
<td class="muted">${esc(r.outcome)}</td></tr>`;
}).join('\n')}
</table>

<h2>Method, and three bugs we hit doing it</h2>
<p>A verification tool that produces false positives is worse than none, so these are published
rather than fixed quietly.</p>
${[
  ['Transport success is not input acceptance.',
   'A tool that correctly rejects a call usually returns <code>{"isError":true}</code> rather than throwing. Our first detector only caught exceptions and reported <strong>67 findings that were all wrong</strong> &mdash; 68% of every tool scanned. corpuslaw.us and b2a.bluepillow.com were both verified correct by hand.'],
  ['WebMCP results are multiply encoded.',
   '<code>executeTool()</code> returns <code>{content:[{text:"..."}]}</code> where the text is itself a JSON string, so <code>"isError":true</code> arrives escaped and every substring check silently misses. Peeling the layers cut the count 67 &rarr; 48 &rarr; 6.'],
  ['"I did not look in time" is not "there is nothing there".',
   'Tools register after client-side JS runs. Probing too early reported three live sites as having zero tools; all three had 2&ndash;4. A zero result is now re-checked with fresh contexts before it is believed.']
].map(([t, d]) => `<div class="finding"><div class="t">${t}</div><div class="d">${d}</div></div>`).join('\n')}

<div class="box warn">
<strong>Not verified:</strong> three entries were unreachable from one network and may be fine
elsewhere. A verification report that hides its own uncertainty is worth nothing.
</div>

<h2>What a fix looks like</h2>
<ol>
<li>Land <code>outputSchema</code> in the spec (issue #9) and adopt it. A tool that declares its return type can be checked; one that does not cannot.</li>
<li>Document every input field with units and format.</li>
<li>Make schema and implementation agree where they currently disagree.</li>
<li>Verify registry submissions automatically, so entries advertising absent tools are caught on submit.</li>
</ol>

<h2>Run it yourself</h2>
<div class="box">
<p>No signup, no account. Add one line to a workflow and every pull request is checked.</p>
<pre class="mono" style="overflow:auto;margin:8px 0 0">- uses: webmcp-readiness@v1
  with:
    config: webmcp.config.json</pre>
</div>

<footer>
  Generated ${esc(data.scannedAt)} by scanning ${esc(data.entryCount)} registry entries in ${data.durationSec}s.
  The scan is read-only: it loads public pages, reads declared tool metadata, and invokes each tool
  with arguments synthesised from its own schema.
  <br>Methodology and the full finding set are in the repository &mdash; every number here is reproducible with <code>npm run scan</code>.
</footer>
</div></body></html>`;

mkdirSync(join(__dirname, OUT), { recursive: true });
writeFileSync(join(__dirname, OUT, 'index.html'), indexHtml);
console.log(`wrote ${OUT}/index.html`);
