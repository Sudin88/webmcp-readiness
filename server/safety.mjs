/**
 * URL safety for a service that scans URLs submitted by strangers.
 *
 * This is the security boundary for the hosted checker. Fetching a
 * user-supplied URL from our own network is the textbook SSRF setup: without
 * these checks, anyone could use us to reach private hosts, loopback, or cloud
 * instance metadata, and read the response.
 *
 * Three separate defences, because each alone is bypassable:
 *   1. scheme allowlist           - no file:, gopher:, data:
 *   2. DNS resolution, then check every resolved address
 *   3. re-check on every redirect hop, and disable transparent redirect
 *      following so nothing is validated twice and used once
 *
 * Pure functions plus injected DNS, so it is testable without network access.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/** Ports a browser would actually reach; blocks attempts to probe odd services. */
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

export class BlockedTarget extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'BlockedTarget';
    this.reason = reason;
  }
}

/**
 * Expand an IPv6 address to its 16 bytes.
 *
 * Needed because string matching is not safe here: `new URL()` normalises
 * `::ffff:169.254.169.254` to `::ffff:a9fe:a9fe`, so a regex written against the
 * dotted-quad form never matches a real input. Parse structurally instead.
 * Returns null for anything malformed, which callers treat as unsafe.
 */
function expandIPv6(v) {
  let s = v;
  if (s.includes('%')) return null;           // zone id: strip or refuse, never guess
  const dbl = s.indexOf('::');
  let head, tail;
  if (dbl === -1) {
    head = s.split(':');
    tail = [];
  } else {
    if (s.indexOf('::', dbl + 1) !== -1) return null; // more than one '::'
    head = s.slice(0, dbl) ? s.slice(0, dbl).split(':') : [];
    tail = s.slice(dbl + 2) ? s.slice(dbl + 2).split(':') : [];
  }
  const fill = new Array(8 - head.length - tail.length).fill('0');
  if (fill.length < 0) return null;
  const groups = dbl === -1 ? head : [...head, ...fill, ...tail];
  if (groups.length !== 8) return null;

  const bytes = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(g)) return null;
    if (g.includes('.')) {
      const p = g.split('.').map(Number);
      if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
      bytes.push(...p);
    } else {
      const n = parseInt(g, 16);
      bytes.push((n >> 8) & 0xff, n & 0xff);
    }
  }
  return bytes.length === 16 ? bytes : null;
}

function isPrivateV4(a, b, c, d) {
  if (a === 0) return true;                          // 0.0.0.0/8
  if (a === 10) return true;                         // private
  if (a === 127) return true;                        // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true;           // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;  // private
  if (a === 192 && b === 168) return true;           // private
  if (a === 192 && b === 0) return true;             // IETF protocol assignments
  if (a === 192 && b === 88 && c === 99) return true;// 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true;  // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;   // TEST-NET-3
  if (a >= 224) return true;                         // multicast + reserved
  return false;
}

/**
 * True if an IP literal is somewhere a public scanner has no business going.
 * Covers loopback, RFC1918, link-local (including the 169.254.169.254 metadata
 * endpoint), CGNAT, benchmark and documentation ranges, and every IPv6 form that
 * can be coerced into an IPv4 destination: ::ffff:mapped, v4-compatible, NAT64,
 * 6to4, Teredo, link-local, unique-local and site-local.
 */
export function isPrivateAddress(ip) {
  const v = String(ip).trim().toLowerCase().replace(/^\[|\]$/g, '');
  const version = isIP(v);
  if (version === 4) {
    const p = v.split('.').map(Number);
    return p.length !== 4 ? true : isPrivateV4(p[0], p[1], p[2], p[3]);
  }
  if (version !== 6) return true; // not a valid IP: treat as unsafe

  const b = expandIPv6(v);
  if (!b) return true;                                // unparseable => unsafe
  const all = (n, val) => b.slice(n[0], n[1]).every((x) => x === val);

  if (all([0, 15], 0)) return true;                   // ::
  if (all([0, 15], 0) || (all([0, 14], 0) && b[15] === 1)) return true; // ::1

  // ::ffff:a.b.c.d  (mapped) and ::a.b.c.d  (v4-compatible) both reach IPv4.
  const v4Tail = b.slice(12).join('.');
  const isMapped = all([0, 10], 0) && b[10] === 0xff && b[11] === 0xff;
  // :: and ::1 have an all-zero or near-zero tail too, but they are handled
  // above; excluding them here by b[10]/b[11] would also exclude ::169.254.169.254,
  // which is exactly the form this needs to catch.
  const isCompat = all([0, 12], 0);
  if (isMapped || isCompat) return isPrivateV4(...v4Tail.split('.').map(Number));

  const h0 = b[0], h1 = b[1];
  if ((h0 & 0xfe) === 0xfc) return true;              // fc00::/7 unique-local
  if (h0 === 0xfe && (h1 & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (h0 === 0xfe && (h1 & 0xc0) === 0xc0) return true; // fec0::/10 site-local
  if (h0 === 0xff) return true;                       // ff00::/8 multicast
  if (h0 === 0x01 && h1 === 0x00 && b[2] === 0x00) return true; // 100::/64 discard
  // NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 destination
  if (h0 === 0x00 && h1 === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    return isPrivateV4(...b.slice(12).join('.').split('.').map(Number));
  }
  // 6to4 2002::/16 embeds IPv4 in groups 1-2; Teredo 2001::/32 in groups 2-3
  if (h0 === 0x20 && h1 === 0x02) return isPrivateV4(b[2], b[3], b[4], b[5]);
  if (h0 === 0x20 && h1 === 0x01 && b[2] === 0x00) return isPrivateV4(b[4], b[5], b[6], b[7]);
  return false;
}

/**
 * Validate the shape of a submitted URL. Does no DNS, so it is synchronous and
 * cheap; use resolveAndValidate before actually fetching.
 */
export function parseTargetUrl(raw) {
  if (typeof raw !== 'string') throw new BlockedTarget('not a string');
  const trimmed = raw.trim();
  if (!trimmed) throw new BlockedTarget('empty URL');
  if (trimmed.length > 2048) throw new BlockedTarget('URL too long');
  // No credentials in the URL: they end up in logs and can mask the real host.
  if (trimmed.includes('@')) throw new BlockedTarget('credentials in URL are not allowed');

  let u;
  try {
    u = new URL(trimmed);
  } catch {
    throw new BlockedTarget('not a valid URL');
  }
  if (!ALLOWED_SCHEMES.has(u.protocol)) {
    throw new BlockedTarget('scheme not allowed', u.protocol);
  }
  if (!u.hostname) throw new BlockedTarget('no hostname');
  if (!ALLOWED_PORTS.has(u.port)) {
    throw new BlockedTarget('port not allowed', u.port);
  }
  // An IP literal is allowed, but only if it is public.
  if (isIP(u.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(u.hostname.replace(/^\[|\]$/g, ''))) {
    throw new BlockedTarget('private IP address is not allowed', u.hostname);
  }
  return u;
}

/**
 * Resolve the hostname and reject if any address it maps to is private.
 *
 * Every address is checked, not just the first: a hostname resolving to one
 * public and one private address is a DNS-rebinding attempt, and letting the
 * caller pick which one gets used is exactly the bug to avoid.
 */
export async function resolveAndValidate(rawUrl, { dnsLookup = lookup } = {}) {
  const u = parseTargetUrl(rawUrl);
  const host = u.hostname.replace(/^\[|\]$/g, '');

  if (isIP(host)) return { url: u, addresses: [host] };

  let records;
  try {
    records = await dnsLookup(host, { all: true, verbatim: true });
  } catch (e) {
    throw new BlockedTarget('hostname could not be resolved', e.code || e.message);
  }
  const addresses = (Array.isArray(records) ? records : [records]).map((r) => (typeof r === 'string' ? r : r.address));
  if (!addresses.length) throw new BlockedTarget('hostname resolved to no addresses');

  for (const a of addresses) {
    if (isPrivateAddress(a)) {
      throw new BlockedTarget('hostname resolves to a private address', a);
    }
  }
  return { url: u, addresses };
}

/**
 * Guard a redirect chain. Called for each hop before it is followed, because a
 * public URL can redirect to 169.254.169.254 and the request would carry our
 * privileges with it.
 */
export async function assertRedirectAllowed(nextUrl, opts) {
  return resolveAndValidate(nextUrl, opts);
}

/** Convenience for logging: the host, without credentials or full path. */
export function safeHostLabel(rawUrl) {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return 'invalid';
  }
}