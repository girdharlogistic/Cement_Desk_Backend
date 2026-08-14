import { describe, it, expect } from 'vitest';
import { limitHit, enforceLimit, _resetLimiters } from '../../src/lib/limiter';
import { AppError } from '../../src/lib/errors';

describe('rate limiter (§7.4)', () => {
  it('allows up to max then blocks with retryAfter', () => {
    _resetLimiters();
    for (let i = 0; i < 3; i++) expect(limitHit('k1', 3, 60_000)).toBe(0);
    const retry = limitHit('k1', 3, 60_000);
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);
  });
  it('keys are independent', () => {
    _resetLimiters();
    expect(limitHit('k2', 1, 60_000)).toBe(0);
    expect(limitHit('k3', 1, 60_000)).toBe(0);
    expect(limitHit('k2', 1, 60_000)).toBeGreaterThan(0);
  });
  it('enforceLimit throws 429 RATE_LIMITED', () => {
    _resetLimiters();
    expect(() => enforceLimit('k4', 1, 60_000)).not.toThrow();
    try {
      enforceLimit('k4', 1, 60_000);
      expect.unreachable();
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect(e.status).toBe(429);
      expect(e.code).toBe('RATE_LIMITED');
      expect(e.retryAfter).toBeGreaterThan(0);
    }
  });
});
