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
  }

  /**
   * Claim a slot for `ip`. Returns a release function, or throws with a reason
   * the HTTP layer maps to 429/503.
   */
  acquire(ip) {
    this.#sweep();
    if (!this.fleet.take()) {
      const err = new Error('service busy, try again shortly');
      err.status = 503;
      err.retryAfter = 30;
      throw err;
    }
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

    if (rec.inflight >= this.maxInflight || !rec.bucket.take() || rec.dayCount >= this.dailyCap) {
      const err = new Error('too many scans from your address');
      err.status = 429;
      err.retryAfter = 60;
      throw err;
    }
    rec.dayCount++;
    rec.inflight++;

    let released = false;
    return () => {
      if (released) return;         // release exactly once
      released = true;
      rec.inflight--;
      // Fleet token is not returned: it models work consumed, not concurrency.
    };
  }

  /** Drop idle entries so the map cannot grow without bound. */
  #sweep() {
    if (this.perIp.size < 5000) return;
    const now = Date.now();
    for (const [ip, rec] of this.perIp) {
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

/** Best-effort client address, honouring a single proxy hop. */
export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    const first = xff.split(',')[0].trim();
    if (/^[0-9a-f:.]{3,45}$/i.test(first)) return first;
  }
  return req.socket?.remoteAddress || 'unknown';
}