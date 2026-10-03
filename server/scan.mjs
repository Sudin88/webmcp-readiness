/**
 * Server-side scan for the hosted checker.
 *
 * Reuses lib/probe.mjs and lib/checks.mjs so the website, the CLI and the GitHub
 * Action all report identical findings from identical rules. Any divergence
 * would make the three disagree about the same site, which is exactly the
 * class of bug this project exists to catch.
 */
import { chromium, POLYFILL } from '../lib/probe.mjs';
import { grade, RULES } from '../lib/checks.mjs';
import { resolveAndValidate, BlockedTarget } from './safety.mjs';

const MAX_CONCURRENT = 3;   // each context is a real browser; memory-bound
const MAX_QUEUE = 10;       // beyond this, refuse rather than hold sockets open
const MAX_TOOLS = 50;       // per page, so one site cannot monopolise a slot
const MAX_VALUE_CHARS = 2000;
const PROBE_BUDGET_MS = 20000;
const TOOL_TIMEOUT_MS = 5000;

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
    browserPromise = chromium.launch({
      chromiumSandbox: true,
      args: ['--disable-dev-shm-usage', '--renderer-process-limit=2']
    }).catch((e) => { browserPromise = null; throw e; });   // do not cache a failure
  }
  return browserPromise;
}

async function withSlot(fn) {
  if (active >= MAX_CONCURRENT) {
    if (queue.length >= MAX_QUEUE) throw new BlockedTarget('server busy, retry shortly');
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
      ignoreHTTPSErrors: false
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

    // probePage opens its own context, so for the hosted path we do the work
    // here where the route guard is installed.
    let page;
    try {
      page = await ctx.newPage();
      const resp = await page.goto(url.href, { waitUntil: 'load', timeout: timeoutMs });
      await page.waitForTimeout(6000);

      // page.evaluate has NO timeout parameter in Playwright, and it can be
      // stalled indefinitely by a page whose tool never resolves. Without this
      // race the slot is never released, and three such requests take the
      // service down permanently.
      const data = await Promise.race([
        evaluateInPage(page),
        new Promise((_, rej) => setTimeout(() => rej(new Error('probe budget exceeded')), PROBE_BUDGET_MS))
      ]).catch((e) => ({ ok: false, error: String(e.message).slice(0, 120) }));
      return buildResult(url.href, resp?.status() ?? null, data, blocked, started);
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

/** Runs in the page. Bounded so one hostile page cannot monopolise a slot. */
function evaluateInPage(page) {
  return page.evaluate(async () => {
        if (!document.modelContext?.getTools) return { ok: false, error: 'document.modelContext absent', tools: [] };
        // Limits are inlined, not referenced: this function is stringified into
        // the browser and cannot close over module scope.
        const tools = (await document.modelContext.getTools()).slice(0, 50);
        const out = [];
        for (const t of tools) {
          const props = t.inputSchema?.properties || {};
          const full = {};
          for (const [k, v] of Object.entries(props)) {
            if (v?.type === 'string') full[k] = v.default ?? v.examples?.[0] ?? (v.enum ? v.enum[0] : 'test');
            else if (v?.type === 'number' || v?.type === 'integer') full[k] = typeof v.default === 'number' ? v.default : 1;
            else if (v?.type === 'boolean') full[k] = false;
            else if (v?.type === 'array') full[k] = [];
            else if (v?.type === 'object') full[k] = {};
          }
          const required = t.inputSchema?.required || [];
          const partial = {};
          for (const k of required.slice(1)) if (k in full) partial[k] = full[k];
          // Limits inlined: this function is stringified into the browser and
          // cannot close over module scope. Without the race, a page whose tool
          // never resolves hangs the whole scan.
          const call = async (a) => {
            try {
              const r = await Promise.race([
                document.modelContext.executeTool(t, JSON.stringify(a)),
                new Promise((_, rej) => setTimeout(() => rej(new Error('tool timeout')), 5000))
              ]);
              // Cap stored output: an uncapped value lands in the response body
              // and in memory on every request.
              return { ok: true, value: JSON.stringify(r).slice(0, 2000) };
            } catch (e) {
              return { ok: false, value: `${e.name}: ${e.message}`.slice(0, 160) };
            }
          };
          out.push({
            name: t.name || null,
            // Attacker-controlled text; the report UI must render it as text,
            // never as markup. Capped so a huge description cannot bloat a response.
            description: (t.description || '').slice(0, 2000),
            inputSchema: t.inputSchema || null,
            outputSchema: t.outputSchema ?? null,
            call1: await call(full),
            call2: await call(full),
            partialCall: required.length > 1 ? await call(partial) : null,
            missingRequired: Math.max(0, required.length - Object.keys(partial).length)
          });
        }
        return { ok: true, tools: out };
      });

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
  const bySeverity = (s) => findings.filter((f) => f.severity === s).length;
  return {
    ...base,
    outcome: 'tools-observable',
    toolsFound: data.tools.length,
    tools: data.tools.map((t) => ({ name: t.name, description: t.description })),
    summary: { high: bySeverity('high'), medium: bySeverity('medium'), info: bySeverity('info'), total: findings.length },
    findings: findings.map((f) => ({ ...f, ...(RULES[f.rule] || {}) }))
  };
}