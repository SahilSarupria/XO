/**
 * Per-key token bucket with an injected clock. A key is whatever the caller rate-limits on (the runner uses the connector id).
 *
 * `reserve` never blocks and never sleeps: it either takes a token now (`waitMs` 0) or reserves the next free slot and says how long the
 * caller must wait before using it. Reservations are queued in order, so a burst of callers is spread out rather than all told to retry
 * at the same instant. A caller whose wait would exceed its own deadline can `cancel` the reservation and give the token back.
 *
 * Limits are per process. Two processes sharing a destination each get their own bucket; the limiter says so rather than pretending otherwise.
 */
export interface RateLimit {
  /** Sustained rate, in calls per second. Must be > 0. */
  readonly perSecond: number;
  /** Largest burst. Default: max(1, ceil(perSecond)). */
  readonly burst?: number;
}

export interface Reservation {
  /** Milliseconds to wait before the call may be made. 0 = go now. */
  readonly waitMs: number;
  /** Returns the reserved token (call this if the caller gives up waiting and will not make the call). */
  cancel(): void;
}

interface Bucket {
  tokens: number;
  /** Time at which `tokens` was last brought up to date. */
  at: number;
}

export class RateLimiters {
  private readonly buckets = new Map<string, Bucket>();
  private readonly limits = new Map<string, Required<RateLimit>>();

  constructor(
    limits: Readonly<Record<string, RateLimit>>,
    private readonly now: () => number = Date.now,
    /** Applied to keys with no explicit entry. Absent means such keys are not limited. */
    private readonly fallback?: RateLimit,
  ) {
    for (const [key, l] of Object.entries(limits)) this.limits.set(key, normalize(key, l));
    if (fallback !== undefined) normalize('(default)', fallback);
  }

  /** Whether `key` is limited at all. */
  has(key: string): boolean {
    return this.limits.has(key) || this.fallback !== undefined;
  }

  reserve(key: string): Reservation {
    const limit = this.limits.get(key) ?? (this.fallback !== undefined ? normalize('(default)', this.fallback) : undefined);
    if (limit === undefined) return { waitMs: 0, cancel: () => undefined };
    const now = this.now();
    let b = this.buckets.get(key);
    if (b === undefined) {
      b = { tokens: limit.burst, at: now };
      this.buckets.set(key, b);
    }
    // refill; a clock that goes backwards refills nothing
    const elapsed = Math.max(0, now - b.at);
    b.tokens = Math.min(limit.burst, b.tokens + (elapsed * limit.perSecond) / 1000);
    b.at = Math.max(b.at, now);
    b.tokens -= 1; // may go negative: that is the queue of reservations ahead of this one
    const waitMs = b.tokens >= 0 ? 0 : Math.ceil((-b.tokens * 1000) / limit.perSecond);
    let cancelled = false;
    const bucket = b;
    return {
      waitMs,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        bucket.tokens = Math.min(limit.burst, bucket.tokens + 1);
      },
    };
  }
}

function normalize(key: string, l: RateLimit): Required<RateLimit> {
  if (!Number.isFinite(l.perSecond) || l.perSecond <= 0) throw new Error(`rate limit for "${key}": perSecond must be a positive number`);
  const burst = l.burst ?? Math.max(1, Math.ceil(l.perSecond));
  if (!Number.isInteger(burst) || burst < 1) throw new Error(`rate limit for "${key}": burst must be a positive integer`);
  return { perSecond: l.perSecond, burst };
}
