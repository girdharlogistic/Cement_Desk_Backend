import { errors } from './errors';

/**
 * In-memory sliding-window rate limiter (§7.4). Per-replica approximation; a
 * multi-replica deployment should back this with Redis. Deterministic and
 * dependency-free, which keeps ordering semantics simple: it runs inside
 * handlers where the relevant key (IP, email, userId, deviceId) is known.
 */
const buckets = new Map<string, number[]>();

setInterval(() => {
  const cutoff = Date.now() - 3600_000;
  for (const [k, arr] of buckets) {
    while (arr.length && arr[0] < cutoff) arr.shift();
    if (!arr.length) buckets.delete(k);
  }
}, 300_000).unref();

/** Returns seconds until the next attempt is allowed, or 0 when allowed. */
export function limitHit(key: string, max: number, windowMs: number): number {
  const now = Date.now();
  const cutoff = now - windowMs;
  let arr = buckets.get(key);
  if (!arr) {
    arr = [];
    buckets.set(key, arr);
  }
  while (arr.length && arr[0] < cutoff) arr.shift();
  if (arr.length >= max) return Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000));
  arr.push(now);
  return 0;
}

export function enforceLimit(key: string, max: number, windowMs: number): void {
  const retry = limitHit(key, max, windowMs);
  if (retry > 0) throw errors.rateLimited(retry);
}

/** Test helper. */
export function _resetLimiters(): void {
  buckets.clear();
}
