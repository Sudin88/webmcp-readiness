import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 4599;

const server = createServer((req, res) => {
  if (req.url.startsWith('/fixture')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(readFileSync(join(__dirname, 'fixture/index.html')));
    return;
  }
  if (req.url.startsWith('/polyfill')) {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(readFileSync(join(__dirname, 'node_modules/@mcp-b/global/dist/index.iife.js')));
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

// Inject the polyfill BEFORE any page script runs.
await page.addInitScript({ path: join(__dirname, 'node_modules/@mcp-b/global/dist/index.iife.js') });

await page.goto(`http://127.0.0.1:${PORT}/fixture`, { waitUntil: 'load' });
await page.waitForTimeout(1500);

const hasMC = await page.evaluate(() => typeof document.modelContext);
console.log('=== document.modelContext:', hasMC);
console.log('=== console:', logs.length ? logs.join('\n') : '(none)');

const tools = await page.evaluate(async () => {
  if (!document.modelContext) return null;
  const t = await document.modelContext.getTools();
  return t.map((x) => ({ name: x.name, description: x.description, inputSchema: x.inputSchema }));
});
console.log('=== tools discovered:', tools ? tools.length : 'N/A');
if (tools) console.log(tools.slice(0, 3).map(t => ` - ${t.name}`).join('\n'));

// Probe: call a tool twice and see if the contract is stable.
const probe = await page.evaluate(async () => {
  const t = await document.modelContext.getTools();
  const find = (n) => t.find((x) => x.name === n);
  const call = async (toolObj, args) => {
    try {
      const r = await document.modelContext.executeTool(toolObj, JSON.stringify(args));
      return { ok: true, result: JSON.stringify(r).slice(0, 200) };
    } catch (e) {
      return { ok: false, error: `${e.name}: ${e.message}`.slice(0, 200) };
    }
  };
  const out = {};
  const po = find('place-order');
  out.placeOrder_1st = await call(po, { item: 'widget' });
  out.placeOrder_2nd = await call(po, { item: 'widget' });
  out.divide_badInput = await call(find('divide'), { a: 1, b: 0 });
  out.createProfile_missingRequired = await call(find('create-profile'), { name: 'Ada' });
  out.subscribe_valid = await call(find('subscribe'), { email: 'ada@example.com' });
  out.toolCount = t.length;
  return out;
});
console.log('=== probe results ===');
console.log(JSON.stringify(probe, null, 2));

await browser.close();
server.close();
