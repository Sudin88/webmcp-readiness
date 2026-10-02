import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1100, height: 1000 }, deviceScaleFactor: 1 });
const errs = [];
p.on('pageerror', e => errs.push(e.message));
await p.goto('file:///tmp/opencode/webmcp-probe/site/index.html', { waitUntil: 'load' });
await p.screenshot({ path: 'site/preview.png', fullPage: false });
const h = await p.evaluate(() => document.body.scrollHeight);
const overflow = await p.evaluate(() => {
  const d = document.documentElement;
  return { scrollW: d.scrollWidth, clientW: d.clientWidth };
});
console.log('page height:', h, 'px');
console.log('horizontal overflow:', overflow.scrollW > overflow.clientW ? `YES (${overflow.scrollW}>${overflow.clientW})` : 'none');
console.log('js errors:', errs.length ? errs : 'none');
await b.close();
