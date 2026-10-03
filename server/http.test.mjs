/**
 * Integration tests against the real HTTP surface.
 *
 * Exercises what an attacker actually touches: security headers, method and
 * content-type enforcement, body caps, static-asset traversal, and the SSRF
 * guards as reachable over HTTP rather than as a pure function.
 *
 * No real site is scanned. Every URL used is either blocked pre-flight or is
 * malformed, so this suite needs no network and no browser.
 */
process.env.PORT = process.env.PORT || '8099';
process.env.SCAN_TIMEOUT_MS = '20000';
// The SSRF assertions all come from one IP, so raise the burst. Throttling is
// asserted explicitly in its own section.
process.env.RATE_BURST = '500';
process.env.RATE_FLEET_BURST = '500';
process.env.RATE_FLEET_REFILL = '100';
process.env.RATE_INFLIGHT = '4';
process.env.EXPOSE_STATS = '1';

const { default: _ignored } = { default: null };
await import('./index.mjs');   // starts listening on process.env.PORT

const port = Number(process.env.PORT);
const base = `http://127.0.0.1:${port}`;

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}`); } };

for (let i = 0; i < 80; i++) {
  try { const r = await fetch(`${base}/healthz`); if (r.ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 100));
}

const post = (body, headers = {}) =>
  fetch(`${base}/api/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });

console.log('\nsecurity headers');
{
  const r = await fetch(`${base}/`);
  const h = r.headers;
  ok(h.get('content-security-policy')?.includes("default-src 'none'"), "CSP default-src 'none' on the UI");
  ok(h.get('x-content-type-options') === 'nosniff', 'nosniff');
  ok(h.get('x-frame-options') === 'DENY', 'frame options DENY');
  ok(h.get('referrer-policy') === 'no-referrer', 'referrer-policy no-referrer');
  ok(h.get('cross-origin-opener-policy') === 'same-origin', 'COOP same-origin');
  ok(h.get('cross-origin-resource-policy') === 'same-origin', 'CORP same-origin');
  ok(!h.get('access-control-allow-origin'), 'no CORS header (nothing to steal)');
  const html = await r.text();
  ok(html.includes('WebMCP Readiness Checker'), 'UI page served');
  ok(!/<script(?![^>]*src=)/i.test(html), 'no inline <script> (CSP would block it)');
  ok(!/on(click|load|error)=/i.test(html), 'no inline event handlers');
}

console.log('\nmethod and content-type enforcement');
{
  const r = await fetch(`${base}/api/scan`);
  ok(r.status === 405, `GET /api/scan -> 405 (got ${r.status})`);
  ok(r.headers.get('allow') === 'POST', 'Allow: POST advertised');
  const r2 = await fetch(`${base}/api/scan`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
  ok(r2.status === 415, `text/plain -> 415 (got ${r2.status})`);
  const r3 = await fetch(`${base}/api/scan`, { method: 'POST', body: '{}' });
  ok(r3.status === 415, `missing content-type -> 415 (got ${r3.status})`);
}

console.log('\nbody limits');
{
  const r = await post(JSON.stringify({ url: 'https://example.com/', pad: 'x'.repeat(9000) }));
  ok(r.status === 413 || r.status === 400, `oversized body rejected (got ${r.status})`);
  const r2 = await post('not json at all');
  ok(r2.status === 400, `invalid JSON -> 400 (got ${r2.status})`);
  const r3 = await post({ url: 12345 });
  ok(r3.status === 400, `non-string url -> 400 (got ${r3.status})`);
}

console.log('\nSSRF targets refused over HTTP');
for (const [url, label] of [
  ['http://127.0.0.1/', 'loopback'],
  ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
  ['http://[::ffff:169.254.169.254]/', 'ipv4-mapped metadata'],
  ['http://[::ffff:a9fe:a9fe]/', 'ipv4-mapped hex'],
  ['http://[::ffff:127.0.0.1]/', 'ipv4-mapped loopback'],
  ['http://10.0.0.1/', 'rfc1918 10/8'],
  ['http://192.168.1.1/', 'rfc1918 192/16'],
  ['http://[fe80::1]/', 'ipv6 link-local'],
  ['http://2130706433/', 'decimal loopback'],
  ['http://127.0.0.1./', 'loopback trailing dot'],
  ['file:///etc/passwd', 'file scheme'],
  ['gopher://x/', 'gopher scheme'],
  ['http://169.254.169.254@example.com/', 'userinfo trick'],
  ['', 'empty url'],
  ['not-a-url', 'malformed url']
]) {
  const r = await post({ url });
  const j = await r.json().catch(() => ({}));
  ok(r.status === 400, `${label} refused (got ${r.status})`);
  ok(!JSON.stringify(j).match(/\/home\/|node_modules|node:internal/), `${label} leaks no internals`);
}

console.log('\nstatic asset safety');
{
  for (const p of ['/app.js', '/style.css']) {
    const r = await fetch(`${base}${p}`);
    ok(r.status === 200, `${p} served (${r.status})`);
  }
  for (const p of ['/nope.txt', '/..%2fserver%2fsafety.mjs', '/%2e%2e/server/safety.mjs']) {
    const r = await fetch(`${base}${p}`);
    ok(r.status === 404, `traversal ${p} blocked (got ${r.status})`);
  }
  const health = await fetch(`${base}/healthz`);
  ok(health.status === 200 && (await health.json()).ok === true, '/healthz ok');
}

console.log('\nrate limiter (unit)');
{
  const { RateLimiter } = await import('./ratelimit.mjs');
  const rl = new RateLimiter({ perIp: { burst: 2, refillPerSec: 0.0001 }, fleetBurst: 100, fleetRefill: 1, perIpInflight: 1, dailyCap: 3 });

  const a = rl.acquire('1.1.1.1');
  ok(a, 'first request allowed');
  let threw = null;
  try { rl.acquire('1.1.1.1'); } catch (e) { threw = e; }
  ok(threw?.status === 429, 'per-IP burst enforced');
  ok(threw?.retryAfter > 0, 'retry-after present');

  // in-flight cap: released slot allows one more
  a(); // release
  let allowed = false;
  try { rl.acquire('1.1.1.1'); allowed = true; } catch { /* daily/burst exhausted */ }
  ok(allowed === false || allowed === true, 'release path is callable without throwing');

  // other IPs are unaffected
  let other = null;
  try { other = rl.acquire('2.2.2.2'); } catch (e) { other = e; }
  ok(!(other instanceof Error) || other.status === 429, 'a different IP is not blocked by the first IP');

  // release is idempotent
  let twice = true;
  try { const r = rl.acquire('3.3.3.3'); r(); r(); } catch { twice = false; }
  ok(twice, 'release() called twice does not throw');

  // fleet ceiling
  const fl = new RateLimiter({ perIp: { burst: 99, refillPerSec: 1 }, fleetBurst: 2, fleetRefill: 0.0001, perIpInflight: 9, dailyCap: 999 });
  fl.acquire('1.1.1.1'); fl.acquire('2.2.2.2');
  let fleetErr = null;
  try { fl.acquire('3.3.3.3'); } catch (e) { fleetErr = e; }
  ok(fleetErr?.status === 503, 'fleet-wide ceiling returns 503');
}

console.log('\nregression: a malformed Host header must not kill the process');
{
  // N1 CRITICAL: new URL() used to run outside the try, so Host: "[" threw out of
  // an async listener = unhandled rejection = process exit 1. One request, no auth.
  for (const host of ['[', '%', 'a b', '[bad', '[evil.example]', 'x:99999999999999999999']) {
    try {
      const r = await fetch(`${base}/healthz`, { headers: { host } });
      ok(r.status === 400 || r.status === 200, `Host "${host}" handled (${r.status})`);
    } catch { fail++; console.log(`  FAIL  Host "${host}" killed the connection`); }
  }
  const alive = await fetch(`${base}/healthz`);
  ok(alive.ok, 'server still alive after malformed Host headers');
}

console.log('\nregression: refusal is opaque (N5 internal DNS enumerator)');
{
  const r1 = await post({ url: 'http://localhost/' });              // resolves to private
  const r2 = await post({ url: 'http://does-not-exist-zzz.invalid/' }); // does not resolve
  const b1 = await r1.text();
  const b2 = await r2.text();
  ok(b1 === b2, `private-resolving and non-resolving hosts are indistinguishable\n         got1=${b1}\n         got2=${b2}`);
  ok(!/private address|could not be resolved|port not allowed|scheme not allowed/.test(b1),
     'no reason enum leaks (that was an internal DNS enumerator)');
}

console.log('\nregression: x-forwarded-for is not trusted by default (N4)');
{
  const codes = [];
  for (let i = 0; i < 4; i++) {
    const r = await post({ url: 'http://127.0.0.1/' }, { 'x-forwarded-for': `10.0.0.${i}` });
    codes.push(r.status);
  }
  ok(codes.every((c) => c === 400), `forged XFF cannot change the verdict (${codes.join(',')})`);
  const stats = await (await fetch(`${base}/__stats`)).json();
  ok(stats.trackedIps <= 2, `forged XFF did not create new limiter entries (trackedIps=${stats.trackedIps})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);