/**
 * Server-side scan for the hosted checker.
 *
 * Reuses lib/probe.mjs and lib/checks.mjs so the website, the CLI and the GitHub
 * Action all report identical findings from identical rules. Any divergence
 * would make the three disagree about the same site, which is exactly the
 * class of bug this project exists to catch.
 */
import { writeFileSync } from 'node:fs';
import { chromium, POLYFILL, runProbe } from '../lib/probe.mjs';
import { grade, RULES } from '../lib/checks.mjs';
import { resolveAndValidate, BlockedTarget } from './safety.mjs';

const MAX_CONCURRENT = 3;   // each context is a real browser; memory-bound
const MAX_QUEUE = 10;       // beyond this, refuse rather than hold sockets open
const MAX_TOOLS = 50;       // per page, so one site cannot monopolise a slot
const MAX_VALUE_CHARS = 2000;
// The in-page 5s tool timeout only fires for ASYNC stalls. A tool that blocks
// the renderer thread synchronously (a busy loop) defeats it, because setTimeout
// cannot run on a blocked event loop. Verified locally: a page with a 60s spin
// ignored the 5s timeout entirely. The Node-side PROBE_BUDGET_MS is therefore
// the control that actually bounds a scan, and it holds: a spinning renderer
// still released its slot at exactly 20s, and ctx.close() returned in 0.0s.
// Consequence to be aware of: a page exposing many genuinely slow tools may be
// truncated and reported as 'probe budget exceeded' rather than mis-scored.
const PROBE_BUDGET_MS = 20000;
const TOOL_TIMEOUT_MS = 5000;
const NAV_BUDGET_MS = 25000;   // a slow page must not hold a slot for the full 45s nav timeout

let browserPromise = null;
let active = 0;
const queue = [];

async function getBrowser() {
  // Launch once and reuse. Launching Chromium per request would dominate latency.
  if (!browserPromise) {
    // The renderer sandbox stays ON. This service loads pages chosen by
    // anonymous visitors, so the sandbox is the only boundary between their
    // JavaScript and this host. --disable-dev-shm-usage is a container concern
    // (small /dev/shm), not a security control, and is safe to keep.
    // The sandbox is the whole boundary between an anonymous visitor's JavaScript
    // and this host. It is also the part most likely to be unavailable: Chromium
    // needs either unprivileged user namespaces, or a SUID helper on a filesystem
    // that is not mounted nosuid. Many hosts disable the first (Ubuntu 23.10+ sets
    // apparmor_restrict_unprivileged_userns=1) and most containers mount the second
    // away, so the safe configuration frequently cannot start at all.
    //
    // Rather than silently downgrade to an unsandboxed renderer, refuse to serve,
    // unless an operator has explicitly accepted the risk.
    const wantSandbox = process.env.ALLOW_UNSANDBOXED !== '1';
    browserPromise = chromium.launch({
      chromiumSandbox: wantSandbox,
      args: ['--disable-dev-shm-usage', '--renderer-process-limit=2']
    })
      .then(async (b) => {
        // Prove the sandbox is actually on. Playwright's default for the bundled
        // headless shell is UNSANDBOXED (--no-zygote-sandbox), verified inside the
        // image, so trusting the default or the option alone is not enough. If the
        // sandbox cannot be established, refuse to serve rather than quietly
        // render anonymous pages with no isolation.
        const v = b.version();
        const ok = await assertSandboxed(b);
        if (wantSandbox && !ok) {
          // Requested the sandbox, did not get one: refuse. Trusting the option
          // alone is not enough, because Playwright's default for the bundled
          // headless shell is unsandboxed.
          await b.close().catch(() => {});
          throw new Error(
            'Chromium launched WITHOUT its sandbox, so refusing to serve. This ' +
            `service renders anonymous pages and the sandbox is the only boundary. ` +
            `Playwright ${v}. Fix the host (see server/DEPLOY.md blocker 2), or set ` +
            'ALLOW_UNSANDBOXED=1 to accept the risk explicitly.'
          );
        }
        if (!wantSandbox) {
          console.warn(
            `[SECURITY] ALLOW_UNSANDBOXED=1 - Chromium ${v} is running WITHOUT its ` +
            'sandbox (verification: ' + (ok ? 'sandbox active anyway' : 'confirmed off') +
            '). Anyone who can submit a URL can attempt renderer RCE. Acceptable ' +
            'only for a private instance with no untrusted input.'
          );
        }
        return b;
      })
      .catch((e) => {
        browserPromise = null;                                // do not cache a failure
        // Chromium dies at launch when no sandbox is available, so we never reach
        // the assertion below. Translate it, or the operator gets a bare
        // "Target page, context or browser has been closed".
        if (wantSandbox) {
          throw new Error(
            'Chromium could not start a sandboxed renderer. This host likely sets ' +
            'apparmor_restrict_unprivileged_userns=1 (Ubuntu 23.10+) or mounts the ' +
            'root filesystem nosuid, so neither the userns nor the setuid sandbox can ' +
            'initialise. See server/DEPLOY.md blocker 2 for the options. ' +
            'ALLOW_UNSANDBOXED=1 accepts the risk explicitly and is not safe for a ' +
            `public endpoint. Underlying error: ${String(e?.message).split('\n')[0].slice(0, 120)}`
          );
        }
        throw e;
      });
    // Record that Chromium works here, for server/healthcheck.mjs to consume.
    browserPromise.then(() => {
      try { writeFileSync(process.env.BROWSER_STAMP || '/tmp/.browser-ok', String(Date.now())); } catch { /* read-only fs */ }
    }).catch(() => {});
  }
  return browserPromise;
}

/**
 * Confirm the renderer sandbox is live by opening a fresh target under
 * chrome://sandbox and reading what the browser reports about itself.
 */
async function assertSandboxed(browser) {
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('chrome://sandbox', { waitUntil: 'domcontentloaded', timeout: 10000 });
    const txt = await page.evaluate(() => document.body.innerText || '');
    await ctx.close().catch(() => {});
    // The sandbox status page says "No Sandbox" when the setuid/userns sandbox is
    // unavailable. Treat anything else as sandboxed.
    return !/no sandbox/i.test(txt);
  } catch {
    return false;   // could not confirm => assume unsafe
  }
}

async function withSlot(fn) {
  if (active >= MAX_CONCURRENT) {
    if (queue.length >= MAX_QUEUE) {
      // Must carry a status, or index.mjs falls through to the refusal branch and
      // tells a legitimate visitor their URL was rejected because we are busy.
      const busy = new BlockedTarget('server busy, retry shortly');
      busy.status = 503;
      busy.retryAfter = 30;
      throw busy;
    }
    await new Promise((r) => queue.push(r));
  }
  active++;
  try { return await fn(); }
  finally {
    active--;
    const next = queue.shift();
    if (next) next();
  }
}

export async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    await b?.close?.();
    browserPromise = null;
  }
}

/**
 * Scan one user-submitted URL.
 *
 * Every outbound request the page makes is validated before it leaves, which
 * covers the redirect chain and any subresource a malicious page might try to
 * use as a pivot into the internal network. DNS answers are cached per host for
 * the life of the scan so this does not become a lookup storm.
 */
export async function scanUrl(rawUrl, { timeoutMs = 45000 } = {}) {
  const started = Date.now();
  const { url } = await resolveAndValidate(rawUrl);

  return withSlot(async () => {
    const browser = await getBrowser();
    const ctx = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 webmcp-readiness-checker/0.1',
      ignoreHTTPSErrors: false,
      // A service worker makes requests from its own context, outside the route
      // handler. Blocking it removes that bypass entirely.
      serviceWorkers: 'block'
    });
    // Without this, document.modelContext is undefined on every page and the
    // checker reports "not ready" for sites that are perfectly fine.
    await ctx.addInitScript({ path: POLYFILL });

    const dnsCache = new Map();
    // Only an aggregate count and the fixed reason enum ever leave the server.
    // Returning per-URL verdicts would let a submitter enumerate the VPC:
    // "resolves to a private address" vs "could not be resolved" distinguishes
    // internal hosts from nonexistent ones.
    const blocked = { count: 0, reasons: {} };

    // Validate every request the page attempts, not just the first navigation.
    await ctx.route('**/*', async (route) => {
      const target = route.request().url();
      try {
        // Key on host. Keying on the full URL meant every distinct path and
        // query string forced a fresh lookup, which is both slow and gives a
        // rebinding resolver many chances to answer differently.
        const host = new URL(target).hostname;
        if (!dnsCache.has(host)) await resolveAndValidate(target);
        dnsCache.set(host, true);
        await route.continue();
      } catch (e) {
        if (e instanceof BlockedTarget) {
          blocked.count++;
          blocked.reasons[e.reason] = (blocked.reasons[e.reason] || 0) + 1;
          await route.abort('blockedbyclient');
        } else {
          await route.abort();
        }
      }
    });

    // WebSocket upgrades never appear as route events. Close them outright.
    if (typeof ctx.routeWebSocket === 'function') {
      await ctx.routeWebSocket('**/*', (ws) => { try { ws.close(); } catch { /* already closed */ } });
    }

    // Redirect hops are NOT route events either - Playwright only sees the
    // original request. So every URL the page actually commits to is re-validated
    // here. This is a second layer, not a replacement for the route guard.
    const committed = [];
    const auditCommit = async (u) => {
      committed.push(u);
      try { await resolveAndValidate(u); }
      catch (e) {
        if (e instanceof BlockedTarget) {
          redirectBlocks.count++;
          redirectBlocks.reasons[e.reason] = (redirectBlocks.reasons[e.reason] || 0) + 1;
        }
      }
    };
    const redirectBlocks = { count: 0, reasons: {} };

    // probePage opens its own context, so for the hosted path we do the work
    // here where the route guard is installed.
    let page;
    try {
      page = await ctx.newPage();
      page.on('framenavigated', (f) => { if (f === page.mainFrame()) auditCommit(f.url()); });

      const resp = await Promise.race([
        page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('navigation budget exceeded')), NAV_BUDGET_MS))
      ]).catch((e) => { throw e; });
      // Re-validate where we actually ended up: an open redirect lands here and
      // is not a route event, so the interceptor never saw it.
      await auditCommit(page.url());
      await page.waitForTimeout(6000);

      // page.evaluate has NO timeout parameter in Playwright, and it can be
      // stalled indefinitely by a page whose tool never resolves. Without this
      // race the slot is never released, and three such requests take the
      // service down permanently.
      const data = await Promise.race([
        runProbe(page, { toolTimeoutMs: TOOL_TIMEOUT_MS, maxTools: MAX_TOOLS }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('probe budget exceeded')), PROBE_BUDGET_MS))
      ]).catch((e) => ({ ok: false, error: String(e.message).slice(0, 120) }));
      blocked.count += redirectBlocks.count;
      for (const [k, v] of Object.entries(redirectBlocks.reasons)) {
        blocked.reasons[k] = (blocked.reasons[k] || 0) + v;
      }
      return buildResult(page.url(), resp?.status() ?? null, data, blocked, started);
    } catch (err) {
      // Never return err.message raw: Playwright call logs carry absolute paths
      // and dependency versions. First line only, capped.
      const brief = String(err?.message || 'scan failed').split('\n')[0].slice(0, 160);
      return {
        url: url.href, outcome: 'unreachable', scannedAt: new Date().toISOString(),
        durationMs: Date.now() - started, blockedRequests: blocked,
        message: `scan failed: ${brief}`, toolsFound: 0,
        summary: { high: 0, medium: 0, info: 0, total: 0 }, findings: []
      };
    } finally {
      await ctx.close().catch(() => {});
    }
  });
}

/** One mapping for every finding shape the API returns. */
export function mapFinding(f) {
  const meta = RULES[f.rule] || {};
  return {
    ...f,
    title: meta.title || f.rule,
    explanation: meta.why || '',
    detail: f.detail ?? ''
  };
}

function safe(u) {
  try { const x = new URL(u); return x.origin + x.pathname; } catch { return 'invalid-url'; }
}

function buildResult(href, status, data, blocked, started) {
  const base = {
    url: href,
    status,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    blockedRequests: blocked
  };
  if (!data?.ok) {
    return {
      ...base,
      outcome: data?.error === 'document.modelContext absent' ? 'no-webmcp' : 'unreachable',
      message: data?.error || 'the page could not be loaded',
      toolsFound: 0,
      summary: { high: 0, medium: 0, info: 0, total: 0 },
      findings: []
    };
  }
  if (!data.tools.length) {
    return {
      ...base,
      outcome: 'no-tools',
      message: 'The page loaded but registered no WebMCP tools. If it should have some, they may register later than we waited.',
      toolsFound: 0,
      summary: { high: 0, medium: 0, info: 0, total: 0 },
      findings: []
    };
  }

  const findings = [];
  const siteLevel = new Set();
  for (const t of data.tools) {
    for (const f of grade(t, data.tools.length)) {
      if (f.site) {
        if (siteLevel.has(f.rule)) continue;
        siteLevel.add(f.rule);
        findings.push({ rule: f.rule, severity: f.severity, detail: f.detail || null });
      } else {
        findings.push({ tool: t.name, rule: f.rule, severity: f.severity, detail: f.detail || null });
      }
    }
  }
  // If every tool timed out, we proved nothing about the site. Reporting zero
  // high findings then renders a green "Ready for AI agents", which is worse than
  // any false positive: it is confident and wrong.
  // A tool counts as unknown if it timed out OR its response was truncated - in
  // neither case did we observe enough to judge it.
  const observed = data.tools.filter((t) => t.call1 && !t.call1.timeout && !t.call1.truncated).length;
  const inconclusive = data.tools.length - observed;
  const bySeverity = (s) => findings.filter((f) => f.severity === s).length;
  if (inconclusive > 0 && data.tools.length > 0) {
    return {
      ...base,
      // Partial results are still worth returning, but NEVER as a pass. The UI
      // must not be able to read high:0 here and conclude readiness.
      outcome: inconclusive === data.tools.length ? 'inconclusive' : 'partial',
      message: `${inconclusive} of ${data.tools.length} tool(s) did not respond or returned an oversized payload, so readiness could not be determined for those. This is not a pass.`,
      toolsFound: data.tools.length,
      inconclusive,
      summary: { high: 0, medium: 0, info: 0, total: findings.length, inconclusive },
      findings: findings.map(mapFinding)
    };
  }
  return {
    ...base,
    outcome: 'tools-observable',
    inconclusive,
    toolsFound: data.tools.length,
    tools: data.tools.map((t) => ({ name: t.name, description: t.description })),
    summary: { high: bySeverity('high'), medium: bySeverity('medium'), info: bySeverity('info'), total: findings.length },
    // RULES also has a `detail` field (the generic explanation). Spreading it
    // after the finding overwrote the finding's own evidence - the actual error
    // text - so the UI showed the same paragraph N times and never the reason.
    findings: findings.map((f) => {
      const meta = RULES[f.rule] || {};
      return {
        ...f,
        title: meta.title || f.rule,
        explanation: meta.why || '',
        detail: f.detail ?? ''
      };
    })
  };
}