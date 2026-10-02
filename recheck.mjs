import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const U = ['https://www.proxy-compare.com','https://scvd.store','https://www.taxsaleatlas.com'];
const b = await chromium.launch();
for (const u of U) {
  const out = [];
  for (const wait of [2000, 6000, 12000]) {
    const c = await b.newContext();
    await c.addInitScript({ path: join(__dirname,'node_modules/@mcp-b/global/dist/index.iife.js') });
    const p = await c.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.message.slice(0,60)));
    try {
      await p.goto(u, { waitUntil:'domcontentloaded', timeout:30000 });
      await p.waitForTimeout(wait);
      const n = await p.evaluate(async () => {
        if (!document.modelContext?.getTools) return -1;
        return (await document.modelContext.getTools()).length;
      });
      out.push(`${wait}ms:${n}${errs.length?' ERR['+errs[0]+']':''}`);
    } catch(e){ out.push(`${wait}ms:FAIL`); }
    await c.close();
  }
  console.log(u.replace('https://','').padEnd(24), out.join('  '));
}
await b.close();
