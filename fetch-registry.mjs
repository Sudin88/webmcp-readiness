/** Snapshot the WebMCP registry so scans are reproducible. */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

for (const [file, url] of [
  ['reg-domains.json', 'https://webmcp-registry.dev/api/domains'],
  ['reg-tools.json', 'https://webmcp-registry.dev/api/tools']
]) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) { console.error(`${file}: HTTP ${res.status}`); process.exit(1); }
  const body = await res.json();
  writeFileSync(join(__dirname, file), JSON.stringify(body, null, 2));
  console.log(`${file}: ${body.results.length} entries (total field: ${body.total})`);
}
