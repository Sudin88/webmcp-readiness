/**
 * Container healthcheck that actually exercises Chromium.
 *
 * `/healthz` answers as long as the HTTP layer is up, which stays true when the
 * browser cannot start at all - the exact failure seen on a host with
 * kernel.apparmor_restrict_unprivileged_userns=1, where every scan returned 500
 * while the service reported healthy.
 *
 * Strategy: cheap HTTP probe first, then confirm a recent successful browser
 * launch recorded by server/scan.mjs. If no browser has run recently (fresh
 * container, idle service) fall back to launching one now, so a broken sandbox is
 * caught at startup rather than on the first user's scan.
 */
const PORT = process.env.PORT || 9000;
const STAMP = process.env.BROWSER_STAMP || '/tmp/.browser-ok';
const STALE_MS = Number(process.env.BROWSER_STAMP_TTL_MS || 300000); // 5 min

async function httpOk() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

async function browserOk() {
  // An operator who accepted the risk should see that state, not a green light.
  if (process.env.ALLOW_UNSANDBOXED === '1') {
    console.error('[health] DEGRADED: ALLOW_UNSANDBOXED=1, browser has no sandbox');
    return false;
  }
  try {
    const { statSync } = await import('node:fs');
    if (Date.now() - statSync(STAMP).mtimeMs < STALE_MS) return true;   // recently proven
  } catch { /* no stamp yet */ }
  try {
    const { chromium } = await import('playwright');
    // A bare launch() is the UNSANDBOXED default on this platform, so using it
    // here made the check pass on exactly the hosts it was written to catch.
    const b = await chromium.launch({ chromiumSandbox: true });
    const ctx = await b.newContext();
    const page = await ctx.newPage();
    await page.goto('chrome://sandbox', { waitUntil: 'domcontentloaded', timeout: 10000 });
    const txt = await page.evaluate(() => document.body.innerText || '');
    await ctx.close().catch(() => {});
    if (/no sandbox/i.test(txt)) {
      await b.close().catch(() => {});
      console.error('[health] Chromium reports no sandbox - scans will refuse to serve');
      return false;
    }
    await b.close();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(STAMP, String(Date.now()));
    return true;
  } catch (e) {
    console.error(`[health] chromium unavailable: ${String(e?.message).split('\n')[0].slice(0, 160)}`);
    return false;
  }
}

const ok = (await httpOk()) && (await browserOk());
process.exit(ok ? 0 : 1);