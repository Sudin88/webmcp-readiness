/**
 * Browser-side probe. Loads a page, discovers its WebMCP tools, and calls each one.
 *
 * Uses @mcp-b/global so this works on any Chromium - no Chrome 146 build required.
 * The polyfill is injected before page scripts run.
 */
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the polyfill bundle. It can sit at the repo root (dev checkout) or be
 * inlined into a bundled dist/ (published Action), so try the plausible roots.
 */
function resolvePolyfill() {
  const rel = 'node_modules/@mcp-b/global/dist/index.iife.js';
  const candidates = [
    join(__dirname, '..', 'vendor', 'webmcp-polyfill.iife.js'), // vendored, checksummed
    join(__dirname, '..', rel),                               // node_modules fallback
    join(__dirname, rel),
    join(__dirname, '..', '..', rel)
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`Could not locate the WebMCP polyfill. Tried:\n  ${candidates.join('\n  ')}`);
}

/**
 * Verify the vendored polyfill against its recorded checksum.
 *
 * This file is injected into every page the scanner opens, so it is the one
 * piece of third-party code on the hot path of a service that renders anonymous
 * pages. A 40 KB file with a checksum is far easier to review than a six-package
 * dependency tree, and this makes tampering detectable.
 */
function verifyPolyfillIntegrity(path) {
  try {
    const sumFile = path.replace(/\.iife\.js$/, '.sha256');
    if (!existsSync(sumFile)) return;   // not vendored; nothing to check
    const expected = readFileSync(sumFile, 'utf8').trim().split(/\s+/)[0];
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (expected && actual !== expected) {
      throw new Error(
        `WebMCP polyfill checksum mismatch.\n  expected ${expected}\n  actual   ${actual}\n` +
        'Refusing to inject an unverified file into pages. Re-vendor from a trusted source.'
      );
    }
  } catch (e) {
    if (e.message?.includes('checksum mismatch')) throw e;
    // A missing checksum file is not a tampering signal.
  }
}
const POLYFILL = resolvePolyfill();
verifyPolyfillIntegrity(POLYFILL);



export { POLYFILL };

export const CLI_TOOL_TIMEOUT_MS = 5000;

export const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 WebMCP-Readiness/0.1 (+https://github.com/webmcp-readiness)';

const NAV_TIMEOUT = 45000;
const SETTLE = 6000; // client-side registration finishes after DOMContentLoaded

/**
 * The in-page probe, defined once and shared by every entry point.
 *
 * It must be fully self-contained: Playwright serialises this function into the
 * browser, so it cannot close over module scope. Limits arrive as an argument
 * rather than being captured, which is why they are inlined by the caller
 * instead of referenced.
 *
 * It was previously written out three times. The copies had already drifted:
 * one gated the partial call on `missing > 0` and another on
 * `required.length > 1`, so the hosted checker silently never reported
 * required-fields-enforced for single-required-field tools while the CLI did.
 * Same site, different verdict - the exact failure this project exists to
 * prevent. One function, exported as source, is the fix.
 */
function probeBody(cfg) {
  const { maxTools, toolTimeoutMs } = cfg;
  return (async () => {
    const out = { ok: false, apiPresent: false, tools: [], error: null };
    try {
      out.apiPresent = !!document.modelContext?.getTools;
      if (!out.apiPresent) { out.error = 'document.modelContext absent'; return out; }
      // TAMPER CHECK. This function executes in the page's realm, so Math, Promise
      // and setTimeout resolve to window.* - which the page can override. Verified:
      // `Math.max = () => 0` here silently suppresses every required-field finding
      // and the Action reports success. A page must never be able to grade itself.
      if (typeof Math.max(0, 1, 2) !== 'number' || Math.max(0, 1, 2) !== 2) {
        out.error = 'probe_tampered_math'; return out;
      }
      if (typeof setTimeout !== 'function' || !Array.isArray([])) {
        out.error = 'probe_tampered_globals'; return out;
      }
      if (Promise.resolve(1) instanceof Promise !== true) {
        out.error = 'probe_tampered_promise'; return out;
      }

      // Cumulative byte budget for the WHOLE page, not per tool. A tool returning
      // megabytes, multiplied by maxTools and by concurrent scans, is an OOM rather
      // than a failed scan - measured at 1.8 GiB of RSS from a single request.
      let spent = 0;
      const BUDGET = 262144;   // 256 KiB per page
      const MAX_VALUE = 65536; // 64 KiB per response, far above any real payload
      const capValue = (v) => {
        const str = typeof v === 'string' ? v : JSON.stringify(v);
        spent += str.length;
        return { text: str.length > MAX_VALUE ? str.slice(0, MAX_VALUE) : str, truncated: str.length > MAX_VALUE };
      };

      const all = await document.modelContext.getTools();
      const tools = all.slice(0, maxTools);

      for (const tool of tools) {
        const props = (tool.inputSchema && tool.inputSchema.properties) || {};
        const full = {};
        for (const [k, v] of Object.entries(props)) {
          if (v && v.type === 'string') full[k] = v.default ?? v.examples?.[0] ?? (v.enum ? v.enum[0] : 'test');
          else if (v && (v.type === 'number' || v.type === 'integer')) full[k] = typeof v.default === 'number' ? v.default : 1;
          else if (v && v.type === 'boolean') full[k] = false;
          else if (v && v.type === 'array') full[k] = [];
          else if (v && v.type === 'object') full[k] = {};
        }
        const required = (tool.inputSchema && tool.inputSchema.required) || [];
        // Drop the FIRST required field, so the call omits exactly one and we can
        // see whether the tool rejects it. A one-field schema yields {}, which is
        // still a missing-required-field call.
        const partial = {};
        for (const k of required.slice(1)) if (k in full) partial[k] = full[k];
        const missing = Math.max(0, required.length - Object.keys(partial).length);

        // timeout:true distinguishes "we stopped waiting" from "the tool threw",
        // so a slow tool is never scored as a schema violation.
        const call = async (args) => {
          // Identity-based timeout token. Matching on the message string was
          // spoofable: a page throwing an error containing "probe_timeout" would
          // suppress its own HIGH finding.
          const TIMED_OUT = { __probeTimeout: true };
          try {
            const invoke = document.modelContext.executeTool(tool, JSON.stringify(args));
            // toolTimeoutMs <= 0 must mean UNCAPPED, not a zero-millisecond cap.
            // setTimeout(0) is a macrotask: it fires before any tool that crosses
            // an async boundary, which silently disabled three rules.
            const r = toolTimeoutMs > 0
              ? await Promise.race([
                  invoke,
                  new Promise((_, rej) => setTimeout(() => rej(TIMED_OUT), toolTimeoutMs))
                ])
              : await invoke;
            const capped = capValue(r);
            return { ok: true, value: capped.text, truncated: capped.truncated, timeout: false };
          } catch (e) {
            const timedOut = e === TIMED_OUT;
            return {
              ok: false,
              value: timedOut ? `no response within ${toolTimeoutMs}ms` : `${e && e.name}: ${e && e.message}`.slice(0, 160),
              timeout: timedOut,
              truncated: false
            };
          }
        };

        const desc = typeof tool.description === 'string' ? tool.description : '';
        out.tools.push({
          name: tool.name || null,
          description: desc.slice(0, MAX_VALUE),
          inputSchema: tool.inputSchema || null,
          outputSchema: tool.outputSchema ?? null,
          call1: await call(full),
          call2: await call(full),
          partialCall: missing > 0 ? await call(partial) : null,
          missingRequired: missing
        });
      }
      out.ok = true;
      out.budgetExhausted = spent > BUDGET;
    } catch (e) {
      out.error = String(e && e.message).slice(0, 200);
    }
    return out;
  })();
}

/** Serialise the shared probe for page.evaluate. One implementation, all callers. */
export function buildProbeSource(cfg = {}) {
  const merged = {
    maxTools: cfg.maxTools ?? 50,
    // <= 0 means UNCAPPED, not a 0ms cap. See the comment at the call site.
    toolTimeoutMs: cfg.toolTimeoutMs ?? 0
  };
  return `(${probeBody.toString()})(${JSON.stringify(merged)})`;
}

/** Evaluate the shared probe against a page. */
export function runProbe(page, cfg) {
  return page.evaluate(buildProbeSource(cfg));
}

const transient = (r) =>
  /ERR_NETWORK|ERR_CONNECTION|ERR_TIMED_OUT|Execution context was destroyed|net::/i.test(
    String(r?.err || r?.data?.error || '')
  );

/**
 * True when a failure looks like a network hiccup rather than a verdict.
 * Exported so the hosted path retries on the same signal the CLI does, instead of
 * reporting `unreachable` for a DNS blip the CLI would have retried past.
 */
export function isTransient(errText) {
  return /ERR_NETWORK|ERR_CONNECTION|ERR_TIMED_OUT|Execution context was destroyed|net::/i.test(
    String(errText || '')
  );
}

/**
 * Probe one URL. Retries transients, because "I didn't look in time" must never be
 * reported as "no tools" (that bug mislabelled three live sites in the baseline).
 */
export async function probeUrl(browser, url, { attempts = 3 } = {}) {
  let last = null;
  for (let a = 1; a <= attempts; a++) {
    const ctx = await browser.newContext({ userAgent: UA });
    await ctx.addInitScript({ path: POLYFILL });
    const page = await ctx.newPage();
    const r = { status: null, data: null, err: null, attempts: a };
    try {
      const resp = await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT });
      r.status = resp ? resp.status() : null;
      await page.waitForTimeout(SETTLE);
      // Must be positive. 0 means uncapped, which let probePage hang forever on a
      // never-settling tool; grade() maps a timeout to tool-slow, so no verdict changes.
      r.data = await runProbe(page, { toolTimeoutMs: CLI_TOOL_TIMEOUT_MS });
    } catch (err) {
      r.err = err.message.split('\n')[0].slice(0, 160);
    }
    await ctx.close();
    last = r;
    if (!transient(r) && (r.data?.ok || /absent/i.test(r.data?.error || ''))) break;
    if (a < attempts) await new Promise((res) => setTimeout(res, 2500));
  }
  return last;
}

/**
 * Confirm a "no tools" result before reporting it.
 *
 * A page that registers its tools on a timer, behind a slow third-party script, or
 * only on a specific path will intermittently report zero - observed on a live
 * site that reliably exposes 16 tools. Reporting that as "no tools" would be a
 * false alarm in a check whose entire job is to be trustworthy, so re-check with
 * a fresh context and a longer settle before believing it.
 */
export async function confirmNoTools(browser, url) {
  for (const settle of [3000, 8000]) {
    const ctx = await browser.newContext({ userAgent: UA });
    await ctx.addInitScript({ path: resolvePolyfill() });
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT });
      await page.waitForTimeout(settle);
      // Full probe, not metadata-only: grade() needs the call results, and a
      // re-check that skipped them would report tools it never actually called.
      const data = await runProbe(page, { toolTimeoutMs: CLI_TOOL_TIMEOUT_MS });
      if (data?.ok && data.tools.length) return { confirmed: false, tools: data.tools };
    } catch {
      /* keep trying */
    } finally {
      await ctx.close();
    }
  }
  return { confirmed: true, tools: [] };
}

/** Full probe of one page: discover tools, then grade them. */
export async function probePage(browser, url) {
  const r = await probeUrl(browser, url);
  const out = {
    url,
    status: r.status,
    error: r.err || r.data?.error || null,
    outcome: 'unknown',
    tools: [],
    findings: []
  };
  if (r.data?.ok && r.data.tools.length) {
    out.outcome = 'tools-observable';
    out.tools = r.data.tools;
  } else if (r.data?.ok) {
    // Don't assert "no tools" on a single look - confirm with fresh contexts.
    const c = await confirmNoTools(browser, url);
    if (c.confirmed) {
      out.outcome = 'no-tools';
    } else {
      out.outcome = 'tools-observable';
      out.tools = c.tools;
      out.note = `tools appeared only on re-check (${c.tools.length}); the single-shot probe saw zero`;
    }
  } else {
    out.outcome = 'unreachable';
  }
  return out;
}

export { chromium };
