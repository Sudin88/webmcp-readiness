import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1100, height: 1050 } });
await p.goto('file:///tmp/opencode/webmcp-probe/site/index.html', { waitUntil: 'load' });
await p.evaluate(() => window.scrollTo(0, 1500));
await p.screenshot({ path: 'site/preview2.png' });
await b.close();
