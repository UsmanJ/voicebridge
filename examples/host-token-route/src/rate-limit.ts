/**
 * Fixed-window, in-memory rate limiter. DEMO ONLY: per process, reset on restart. A production
 * host should enforce limits at its gateway or with a shared store, per user and per client.
 */
export interface RateLimiter {
  /** Returns false when `key` has exceeded its allowance in the current window. */
  allow(key: string): boolean;
}

export function createRateLimiter(options: {
  limit: number;
  windowMs: number;
  maxKeys?: number;
  now?: () => number;
}): RateLimiter {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 10_000;
  const windows = new Map<string, { start: number; count: number }>();
  return {
    allow(key) {
      const t = now();
      let w = windows.get(key);
      if (!w || t - w.start >= options.windowMs) {
        if (!w && windows.size >= maxKeys) {
          // Bounded memory: drop expired windows, or the oldest one if none have expired.
          for (const [k, v] of windows) if (t - v.start >= options.windowMs) windows.delete(k);
          if (windows.size >= maxKeys) windows.delete(windows.keys().next().value!);
        }
        w = { start: t, count: 0 };
        windows.set(key, w);
      }
      w.count++;
      return w.count <= options.limit;
    },
  };
}
