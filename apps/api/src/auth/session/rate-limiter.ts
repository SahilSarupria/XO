/**
 * Fixed-window, in-memory request limiter. PER PROCESS: it does not coordinate across processes or hosts, so
 * N instances allow roughly N times the configured rate. It exists to blunt a single client hammering one
 * instance, not to be a distributed rate limit, and the docs say so.
 */
export interface RateLimiter {
  /** `true` if the call is allowed (and counted), `false` if `key` is over its limit for the current window. */
  allow(key: string): boolean;
}

export function createRateLimiter(options: { windowMs: number; max: number; maxKeys?: number; now?: () => number }): RateLimiter {
  const now = options.now ?? ((): number => Date.now());
  const maxKeys = options.maxKeys ?? 10_000;
  const windows = new Map<string, { start: number; count: number }>();
  return {
    allow(key: string): boolean {
      const t = now();
      if (windows.size >= maxKeys) {
        for (const [k, w] of windows) if (t - w.start >= options.windowMs) windows.delete(k);
        if (windows.size >= maxKeys) return false; // memory bound reached: refuse rather than grow
      }
      const w = windows.get(key);
      if (w === undefined || t - w.start >= options.windowMs) {
        windows.set(key, { start: t, count: 1 });
        return true;
      }
      if (w.count >= options.max) return false;
      w.count++;
      return true;
    },
  };
}
