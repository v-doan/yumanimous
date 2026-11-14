/**
 * Abuse and cost limits (Phase 9). The API runs as ONE process (presence, locks and
 * these counters all assume it), so counters live in memory; they reset on restart,
 * which only ever makes the limits more lenient for a moment.
 *
 * Why limits matter here: creating and starting a session spends real money (AI)
 * and a small daily recipe quota. Without limits, one script could drain both in
 * minutes and every real group would get the plain deck for the rest of the day.
 */

export interface Limits {
  /** POST /api/sessions, per IP. */
  createPerHour: number;
  /** POST /api/sessions/:code/members, per IP. */
  joinPer10Min: number;
  /** GET /api/sessions/:code, per IP: makes guessing session codes impractical. */
  previewPerMin: number;
  /** New socket connections, per IP. */
  connectPerMin: number;
  /** Swipes per socket: sustained rate and burst. */
  swipesPerSecond: number;
  swipeBurst: number;
  /** Every other socket event, per socket, per 10 seconds. */
  otherEventsPer10s: number;
  /** Start, rebuild, play again, make a list: the actions that spend AI or quota, per IP. */
  costlyPerHour: number;
  /** Sessions that may exist at once (new ones are refused politely past it). */
  maxActiveSessions: number;
}

export const DEFAULT_LIMITS: Limits = {
  createPerHour: 10,
  joinPer10Min: 30,
  previewPerMin: 60,
  connectPerMin: 20,
  swipesPerSecond: 10,
  swipeBurst: 30,
  otherEventsPer10s: 5,
  costlyPerHour: 12,
  maxActiveSessions: 300,
};

/**
 * A token bucket: `capacity` tokens, refilled at `perSecond`. Allows short bursts
 * (a fast swiper) but caps the sustained rate.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.perSecond);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * At most `max` hits per key per `windowMs` (fixed windows). Old keys are dropped
 * as windows expire, so memory stays bounded by recent clients.
 */
export class WindowCounter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): boolean {
    const t = this.now();
    if (this.hits.size > 10_000) this.sweep(t);
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      return true;
    }
    if (entry.count >= this.max) return false;
    entry.count += 1;
    return true;
  }

  private sweep(t: number) {
    for (const [key, entry] of this.hits) if (entry.resetAt <= t) this.hits.delete(key);
  }
}

/**
 * The client's IP. Behind exactly `trustedHops` proxies (Fly's edge = 1), the real
 * client is that many entries from the END of X-Forwarded-For: anything to the left
 * was supplied by the client and can be forged. With no trusted proxy, the socket's
 * own address is used and the header is ignored.
 */
export function clientIp(
  forwardedFor: string | string[] | undefined,
  remoteAddress: string | undefined,
  trustedHops: number,
): string {
  if (trustedHops > 0 && forwardedFor) {
    const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
    const chain = header
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const ip = chain[chain.length - trustedHops];
    if (ip) return ip;
  }
  return remoteAddress ?? 'unknown';
}
