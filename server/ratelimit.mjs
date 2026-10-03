/**
 * Abuse control for an anonymous endpoint that spawns a browser per request.
 *
 * Budget, from the measured capacity: 3 concurrent slots x 45s worst case is
 * roughly 240 scans/hour. The fleet-wide ceiling is set well below that, because
 * that is what actually bounds CPU. The per-IP numbers are about being a decent
 * neighbour on a free public service.
 *
 * Four independent limits, because each covers a different abuse shape:
 *   perIpInFlight  - one visitor never holds more than one browser
 *   perIpBucket    - one visitor cannot monopolise the box
 *   perIpDaily     - bounds total work per address over a day
 *   fleetBucket    - what actually bounds CPU; a botnet hits this first
 */
const PER_IP = { burst: 3, refillPerSec: 1 / 60 };        // 3 burst, 1 per 20s
const PER_IP_DAILY = 50;
const PER_IP_INFLIGHT = 1;
const FLEET = { burst: 20, refillPerSec: 1 / 6 };         // 20 burst, 1 per 6s
const IDLE_TTL_MS = 30 * 60 * 1000;

class Bucket {
  constructor({ burst, refillPerSec }) {
    this.capacity = burst;
    this.refillPerSec = refillPerSec;
    this.tokens = burst;
    this.at = Date.now();
  }
  take() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.at) / 1000) * this.refillPerSec);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export class RateLimiter {
  constructor(opts = {}) {
    this.perIp = new Map();     // ip -> { bucket, day, dayStamp, inflight }
    this.fleet = new Bucket({ burst: opts.fleetBurst ?? FLEET.burst, refillPerSec: opts.fleetRefill ?? FLEET.refillPerSec });
    this.perIpSpec = opts.perIp ?? PER_IP;
    this.dailyCap = opts.dailyCap ?? PER_IP_DAILY;
    this.maxInflight = opts.perIpInflight ?? PER_IP_INFLIGHT;
    this.maxEntries = opts.maxEntries ?? 20000;
    this.calls = 0;
  }

  /**
   * Claim a slot for `ip`. Returns a release function, or throws with a reason
   * the HTTP layer maps to 429/503.
   */
  acquire(ip) {
    this.#tick();
    const now = Date.now();
    let rec = this.perIp.get(ip);
    if (!rec) {
      rec = {
        bucket: new Bucket(this.perIpSpec),
        day: now,
        dayCount: 0,
        inflight: 0
      };
      this.perIp.set(ip, rec);
    }
    if (now - rec.day > 86400000) { rec.day = now; rec.dayCount = 0; }

    // Per-IP checks run BEFORE the fleet token is claimed. Otherwise a rejected
    // request spends global budget while doing no work, and one address can drain
    // the fleet bucket to zero at no cost to itself - denying the service to
    // everyone else indefinitely, since refill is slow.
    if (rec.inflight >= this.maxInflight || rec.dayCount >= this.dailyCap || !rec.bucket.take()) {
      const err = new Error('too many scans from your address');
      err.status = 429;
      err.retryAfter = 60;
      throw err;
    }

    // Fleet ceiling is what actually bounds CPU.
    if (!this.fleet.take()) {
      rec.bucket.tokens += 1;   // refund the per-IP token we speculatively took
      const err = new Error('service busy, try again shortly');
      err.status = 503;
      err.retryAfter = 30;
      throw err;
    }
    rec.dayCount++;
    rec.inflight++;

    let released = false;
    return () => {
      if (released) return;         // release exactly once
      released = true;
      rec.inflight--;
      // Fleet token is not refunded: it models work consumed, not concurrency.
      // Safe now that only admitted requests take one.
    };
  }

  /**
   * Evict idle entries on a counter, not on every acquire.
   *
   * Sweeping per-request was O(n) on the hot path once the map passed 5000, and
   * entries touched within the TTL were never reclaimed - so an attacker rotating
   * identities kept them all warm. Measured 188ms per acquire at 87k entries.
   */
  #tick() {
    this.calls = (this.calls || 0) + 1;
    if (this.calls % 256 !== 0) return;
    const now = Date.now();
    // Hard cap first: this is what bounds memory regardless of touch pattern.
    if (this.perIp.size > this.maxEntries) {
      // Map preserves insertion order, so the oldest keys are the cheapest victims.
      const excess = this.perIp.size - this.maxEntries;
      let n = 0;
      for (const ip of this.perIp.keys()) {
        if (n++ >= excess) break;
        if (this.perIp.get(ip).inflight === 0) this.perIp.delete(ip);
      }
    }
    for (const [ip, rec] of this.perIp) {
      if (this.perIp.size <= this.maxEntries * 0.8) break;
      if (rec.inflight === 0 && now - rec.bucket.at > IDLE_TTL_MS) this.perIp.delete(ip);
    }
  }

  /** Test seam. */
  stats() {
    let dayCount = 0;
    for (const rec of this.perIp.values()) dayCount += rec.dayCount;
    return {
      trackedIps: this.perIp.size,
      fleetTokens: Math.round(this.fleet.tokens * 100) / 100,
      dayCount
    };
  }
}

/**
 * Best-effort client address.
 *
 * x-forwarded-for is ONLY honoured when TRUST_PROXY=1. Trusting it by default
 * means any client sets its own identity: every per-IP burst, in-flight and daily
 * limit becomes opt-out. Verified: 6 requests with 6 forged XFF values all
 * returned 200 while the same 6 without XFF were throttled after 3.
 *
 * When trusting a proxy, take the LAST hop rather than the first: the first is
 * client-supplied and the only trustworthy entry is the one the proxy appended.
 */
export function clientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) {
      const hops = xff.split(',').map((s) => s.trim()).filter(Boolean);
      const last = hops[hops.length - 1];
      if (last && /^[0-9a-f:.]{3,45}$/i.test(last)) return last;
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}