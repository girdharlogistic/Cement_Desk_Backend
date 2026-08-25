import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../../src/lib/cache';

describe('TtlCache', () => {
  it('returns a value inside its TTL and forgets it after', () => {
    vi.useFakeTimers();
    try {
      const c = new TtlCache<number>(1000);
      c.set('a', 1);
      expect(c.get('a')).toBe(1);
      vi.advanceTimersByTime(999);
      expect(c.get('a')).toBe(1);
      vi.advanceTimersByTime(2);
      expect(c.get('a')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('distinguishes a cached null from a miss', () => {
    // firmAccess caches "this user is not a member" as null. If that were
    // indistinguishable from a miss the negative would never be cached, and a
    // wrong firm id would hit the database on every poll.
    const c = new TtlCache<{ role: string } | null>(1000);
    c.set('firm:user', null);
    expect(c.get('firm:user')).toBeNull();
    expect(c.get('firm:other')).toBeUndefined();
  });

  it('drops a key on delete and a family on deletePrefix', () => {
    const c = new TtlCache<number>(1000);
    c.set('f1:u1', 1);
    c.set('f1:u2', 2);
    c.set('f2:u1', 3);
    c.delete('f1:u1');
    expect(c.get('f1:u1')).toBeUndefined();
    c.deletePrefix('f1:');
    expect(c.get('f1:u2')).toBeUndefined();
    expect(c.get('f2:u1')).toBe(3);
  });

  it('evicts oldest-first at the cap rather than growing without bound', () => {
    const c = new TtlCache<number>(1000, 2);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    expect(c.size).toBe(2);
    expect(c.get('a')).toBeUndefined();
    expect(c.get('c')).toBe(3);
  });
});
