/**
 * A small in-process TTL cache.
 *
 * The point of this file is not memory — the whole database is about a
 * megabyte. It is **round trips**. TiDB Serverless bills a request unit per
 * statement almost regardless of how little it returns: a `SELECT role FROM
 * firm_members` that reads one row costs the same 0.5 RU as one that reads
 * fifty. The app polls every fifteen seconds per firm, and every one of those
 * polls re-asked the same three questions — is this session still valid, is
 * this user still a member, does this firm still exist — whose answers change
 * once a month.
 *
 * So: cache the answers, bound the staleness with a short TTL, and invalidate
 * explicitly wherever the answer is *changed*. The backend is a single process
 * behind one systemd unit, so an explicit invalidation is exact — there is no
 * second node holding a stale copy. The TTL is the backstop for the one case
 * invalidation cannot see: a row changed by hand in the SQL console.
 *
 * Nothing security-critical is decided by this cache alone. A revoked session
 * is dropped from the cache the moment it is revoked; the TTL only bounds how
 * long a revocation performed *outside* the process could go unnoticed.
 */
export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expires: number }>();

  /**
   * @param ttlMs      how long an entry may be trusted
   * @param maxEntries hard cap, so a pathological key space cannot grow the
   *                   heap without bound. Eviction is oldest-inserted-first,
   *                   which for these key spaces (sessions, firms) is close
   *                   enough to least-recently-used.
   */
  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 50_000,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    if (this.map.size >= this.maxEntries) {
      // Map preserves insertion order, so the first key is the oldest.
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  /**
   * Drops every entry whose key starts with [prefix]. Used where one change
   * invalidates a family of keys — a firm's membership rows are keyed
   * `firmId:userId`, and removing the firm has to clear all of them.
   */
  deletePrefix(prefix: string): void {
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) this.map.delete(key);
    }
  }

  clear(): void {
    this.map.clear();
  }

  /** Entry count, for the /health readout. */
  get size(): number {
    return this.map.size;
  }
}
