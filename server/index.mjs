/**
 * HTTP layer for the hosted WebMCP readiness checker.
 *
 * Node builtins only - no framework. The route surface is two endpoints and the
 * security surface is most of the file, so a dependency here would be a
 * liability.
 *
 * Design notes that matter:
 *  - CORS is deliberately absent. No cookies, no auth, nothing for a hostile
 *    origin to steal, so sending no Access-Control-Allow-Origin and serving the
 *    UI same-origin is correct. Do not add a wildcard.
 *  - The report echoes third-party page text, so the CSP is default-src 'none'
 *    and the UI never uses innerHTML.
 *  - BlockedTarget.reason is a fixed enum and is safe to return. Its .message is
 *    not, and never crosses the wire.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanUrl, closeBrowser } from './scan.mjs';
import { BlockedTarget, resolveAndValidate } from './safety.mjs';
import { RateLimiter, clientIp } from './ratelimit.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..', 'web');

const PORT = Number(process.env.PORT || 8080);
const MAX_BODY_BYTES = 4096;      // one URL field; safety.mjs caps length too
const SCAN_TIMEOUT_MS = Number(process.env.SCAN_TIMEOUT_MS || 45000);

const SECURITY_HEADERS = {
  // The report renders text taken from pages the submitter chose. default-src
  // 'none' means a missed escape still cannot load or execute anything.
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'geolocation=(), microphone=(), camera=(), interest-cohort=()'
};

// Limits are env-configurable so they can be tuned for the host's actual CPU
// budget, and so the test suite can exercise throttling deterministically.
const num = (k, d) => (process.env[k] ? Number(process.env[k]) : d);
const limiter = new RateLimiter({
  perIp: { burst: num('RATE_BURST', 3), refillPerSec: num('RATE_REFILL', 1 / 60) },
  dailyCap: num('RATE_DAILY', 50),
  perIpInflight: num('RATE_INFLIGHT', 1),
  fleetBurst: num('RATE_FLEET_BURST', 20),
  fleetRefill: num('RATE_FLEET_REFILL', 1 / 6)
});

function send(res, status, body, extraHeaders = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders
  });
  res.end(payload);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html)
  });
  res.end(html);
}

const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

/**
 * Read a body with a hard byte cap enforced as bytes arrive, not via a trusted
 * Content-Length.
 *
 * On overflow we stop reading and reject, but do NOT destroy the socket: doing
 * that gave the client a connection error instead of the 413 it needs to know
 * what happened. The handler sends 413 with Connection: close.
 */
function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        req.pause();
        const e = new Error('request body too large');
        e.status = 413;
        reject(e);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    // ---------------------------------------------------------------- UI
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const file = join(WEB, 'index.html');
        if (!existsSync(file)) return send(res, 500, { error: 'ui_missing' });
        return sendHtml(res, 200, readFileSync(file));
      }
      // Static assets, path-traversal safe: resolve then confirm inside WEB.
      if (url.pathname === '/app.js' || url.pathname === '/style.css') {
        const file = join(WEB, url.pathname.slice(1));
        if (!file.startsWith(WEB) || !existsSync(file)) return send(res, 404, { error: 'not_found' });
        const body = readFileSync(file);
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'content-type': CONTENT_TYPES[extname(file)] || 'application/octet-stream',
          'content-length': body.length
        });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
      if (url.pathname === '/healthz') return send(res, 200, { ok: true });
      if (url.pathname === '/__stats') return send(res, 200, limiter.stats());
      if (url.pathname === '/api/scan') return send(res, 405, { error: 'use_post' }, { allow: 'POST' });
      return send(res, 404, { error: 'not_found' });
    }

    // ---------------------------------------------------------------- API
    if (url.pathname === '/api/scan' && req.method === 'POST') {
      const ctype = String(req.headers['content-type'] || '');
      if (!ctype.toLowerCase().startsWith('application/json')) {
        return send(res, 415, { error: 'content_type_must_be_json' });
      }
      const ip = clientIp(req);
      try {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw.toString('utf8')); }
        catch { return send(res, 400, { error: 'invalid_json' }); }

        // Validate BEFORE claiming a rate-limit slot. Rejecting a bad URL costs
        // no browser, so it must not consume quota - otherwise an attacker could
        // deny the service to a legitimate visitor by burning their IP's budget,
        // and the guard would be unenforceable for anyone being throttled.
        try { await resolveAndValidate(body?.url); }
        catch (e) {
          if (e instanceof BlockedTarget) return send(res, 400, { error: e.reason });
          throw e;
        }

        let release;
        try {
          release = limiter.acquire(ip);
        } catch (e) {
          // Reason is ours, not user input: safe to echo.
          return send(res, e.status || 429, { error: e.message }, { 'retry-after': String(e.retryAfter || 60) });
        }
        try {
          const result = await scanUrl(body?.url, { timeoutMs: SCAN_TIMEOUT_MS });
          return send(res, 200, result, { 'cache-control': 'no-store' });
        } catch (e) {
          if (e instanceof BlockedTarget) {
            // reason is a fixed enum; message carries detail and stays server-side
            return send(res, 400, { error: e.reason }, { 'cache-control': 'no-store' });
          }
          if (e.status === 503) {
            return send(res, 503, { error: e.message }, { 'retry-after': String(e.retryAfter || 30) });
          }
          console.error('[scan] unexpected', e?.stack?.split('\n')[0] || e?.message);
          return send(res, 500, { error: 'scan_failed' });
        } finally {
          release?.();
        }
      } catch (e) {
        if (e.status === 413) return send(res, 413, { error: 'body_too_large' }, { connection: 'close' });
        if (e instanceof BlockedTarget) return send(res, 400, { error: e.reason });
        console.error('[api] unexpected', e?.stack?.split('\n')[0] || e?.message);
        return send(res, 500, { error: 'scan_failed' });
      }
    }

    return send(res, 404, { error: 'not_found' });
  } catch (e) {
    console.error('[http] unhandled', e?.stack?.split('\n')[0] || e?.message);
    if (!res.headersSent) send(res, 500, { error: 'internal' });
  }
});

// Do not let a slow client hold a socket open indefinitely.
server.headersTimeout = 10000;
server.requestTimeout = 60000;
server.keepAliveTimeout = 5000;

server.listen(PORT, () => {
  console.log(`webmcp-readiness checker on :${PORT}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    console.log(`${sig} - closing`);
    server.close();
    await closeBrowser();
    process.exit(0);
  });
}