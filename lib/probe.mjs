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

export const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 WebMCP-Readiness/0.1 (+https://github.com/webmcp-readiness)';

const NAV_TIMEOUT = 45000;
const SETTLE = 6000; // client-side registration finishes after DOMContentLoaded

/**
 * Serialised page function. Must be self-contained (it is stringified into the
 * browser), so it cannot close over anything from this module.
 */
const inPage = async () => {
  const out = { ok: null, apiPresent: false, tools: [], error: null };
  try {
    out.apiPresent = !!document.modelContext?.getTools;
    if (!out.apiPresent) { out.error = 'document.modelContext absent'; return out; }
    const tools = await document.modelContext.getTools();

    for (const tool of tools) {
      const props = tool.inputSchema?.properties || {};
      const full = {};
      for (const [k, v] of Object.entries(props)) {
        if (v?.type === 'string') full[k] = v.default ?? v.examples?.[0] ?? (v.enum ? v.enum[0] : 'test');
        else if (v?.type === 'number' || v?.type === 'integer') full[k] = typeof v.default === 'number' ? v.default : 1;
        else if (v?.type === 'boolean') full[k] = false;
        else if (v?.type === 'array') full[k] = [];
        else if (v?.type === 'object') full[k] = {};
      }
      const required = tool.inputSchema?.required || [];
      const partial = {};
      for (const k of required.slice(1)) if (k in full) partial[k] = full[k];
      const missing = Math.max(0, required.length - Object.keys(partial).length);

      // executeTool() takes JSON *string* args, not an object. Passing an object
      // fails with "Failed to parse input arguments".
      const call = async (args) => {
        try {
          return { ok: true, value: JSON.stringify(await document.modelContext.executeTool(tool, JSON.stringify(args))) };
        } catch (e) {
          return { ok: false, value: `${e.name}: ${e.message}`.slice(0, 160) };
        }
      };

      const a = await call(full);
      const b = await call(full);
      const partialRes = missing > 0 ? await call(partial) : null;

      out.tools.push({
        name: tool.name || null,
        description: tool.description || '',
        inputSchema: tool.inputSchema || null,
        outputSchema: tool.outputSchema ?? null,
        call1: a, call2: b, partialCall: partialRes, missingRequired: missing
      });
    }
    out.ok = true;
  } catch (e) {
    out.error = e.message.slice(0, 200);
  }
  return out;
};

const transient = (r) =>
  /ERR_NETWORK|ERR_CONNECTION|ERR_TIMED_OUT|Execution context was destroyed|net::/i.test(
    String(r?.err || r?.data?.error || '')
  );

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
      r.data = await page.evaluate(inPage);
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
      const data = await page.evaluate(inPage);
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
