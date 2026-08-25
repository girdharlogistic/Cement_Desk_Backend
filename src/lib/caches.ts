import { TtlCache } from './cache';
import { q, qOne } from '../db/pool';
import { nowSql } from './dates';
import { Role } from '../types';

/**
 * The process-wide caches, and the per-firm data watermark.
 *
 * Everything here exists to stop `sync/pull` re-asking questions whose answers
 * change once a month. The app polls every fifteen seconds per firm; before
 * this, each poll cost eleven request units and almost always answered
 * "nothing new". See `lib/cache.ts` for why RU, not memory, is the constraint.
 *
 * Invalidation is explicit and exact — one process, one systemd unit, so
 * clearing an entry here really does clear it everywhere. The TTLs are only a
 * backstop for rows edited outside the process, in the SQL console.
 */

// ── TTLs ─────────────────────────────────────────────────────────────────────
// Deliberately short. The saving comes from a fifteen-second poll hitting a
// warm entry, not from holding data for hours; a long TTL would buy very little
// more and widen every staleness window it is protecting against.

/** Sessions: the shortest, because this one gates access. */
const SESSION_TTL = 20_000;

/** Firm existence and membership: changed by an admin, not by the app. */
const FIRM_TTL = 60_000;

/** The data watermark. Bumps invalidate it, so this only bounds SQL-console edits. */
const MARKER_TTL = 15_000;

// ── Sessions ─────────────────────────────────────────────────────────────────

export interface CachedSession {
  userId: string;
  revoked: boolean;
  expiresAt: string;
  emailVerified: boolean;
}

const sessions = new TtlCache<CachedSession>(SESSION_TTL);

export function cachedSession(sessionId: string): CachedSession | undefined {
  return sessions.get(sessionId);
}

export function cacheSession(sessionId: string, value: CachedSession): void {
  sessions.set(sessionId, value);
}

/**
 * Call the moment a session stops being usable, or its user's verified flag
 * changes — logout, logout-all, session delete, password change, verify-email.
 * Without this a revoked token would keep working for up to [SESSION_TTL].
 */
export function invalidateSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/** Every session of one user. For logout-all, password change, verification. */
export function invalidateAllSessions(): void {
  // Sessions are keyed by id, not by user, and the map is small (one entry per
  // active device). Clearing it costs one cold lookup per device and is much
  // harder to get wrong than tracking a user→sessions index.
  sessions.clear();
}

// ── Firms and membership ─────────────────────────────────────────────────────

const firmRows = new TtlCache<{ deleted: boolean } | null>(FIRM_TTL);
const members = new TtlCache<{ role: Role } | null>(FIRM_TTL);

export function cachedFirmRow(firmId: string): { deleted: boolean } | null | undefined {
  return firmRows.get(firmId);
}

export function cacheFirmRow(firmId: string, value: { deleted: boolean } | null): void {
  firmRows.set(firmId, value);
}

export function cachedMember(firmId: string, userId: string): { role: Role } | null | undefined {
  return members.get(`${firmId}:${userId}`);
}

export function cacheMember(firmId: string, userId: string, value: { role: Role } | null): void {
  members.set(`${firmId}:${userId}`, value);
}

/** Call on any membership or role change, and when a firm is created/deleted. */
export function invalidateFirm(firmId: string): void {
  firmRows.delete(firmId);
  members.deletePrefix(`${firmId}:`);
  markers.delete(firmId);
}

// ── The per-firm data watermark ──────────────────────────────────────────────

const markers = new TtlCache<string | null>(MARKER_TTL);

/**
 * `firms.data_updated_at` — the newest change to anything inside the firm, and
 * `UTC_TIMESTAMP(3)` from the same statement so a caller needs no second round
 * trip for the server clock.
 *
 * A null watermark means "unknown": the column has never been set for this
 * firm, and the caller must not take any shortcut based on it.
 */
export async function firmWatermark(
  firmId: string,
): Promise<{ marker: string | null; now: string; fromDb: boolean }> {
  const cached = markers.get(firmId);
  if (cached !== undefined) {
    // A warm watermark is the whole point: this path must not touch the
    // database at all. `now` therefore comes from this process's clock, which
    // is why the caller is told [fromDb] is false — it is fit for the advisory
    // `serverTime` field and for nothing that is compared against a DB
    // timestamp. Nothing in pull's fast path compares it: the watermark itself
    // was written by the database, and the cursor is not advanced.
    return { marker: cached, now: nowSql(), fromDb: false };
  }
  const row = await qOne<{ marker: string | null; now: string }>(
    'SELECT data_updated_at AS marker, UTC_TIMESTAMP(3) AS now FROM firms WHERE id = ?',
    [firmId],
  );
  const marker = row?.marker ?? null;
  markers.set(firmId, marker);
  return { marker, now: row?.now ?? nowSql(), fromDb: row != null };
}

/**
 * Records that something inside [firmId] changed.
 *
 * Fire-and-forget: a failed watermark write must never fail the request that
 * did the real work. The consequence of losing one is bounded — pull's fast
 * path never advances a client's cursor, so a missed bump can only make a
 * change arrive *late*, never make it disappear. The next successful bump
 * delivers everything from the un-advanced cursor.
 *
 * The cache entry is dropped rather than set to a locally computed time: the
 * watermark is compared against DB timestamps, and this process's clock is not
 * the one that writes them.
 */
export function bumpFirmData(firmId: string): void {
  markers.delete(firmId);
  void q('UPDATE firms SET data_updated_at = UTC_TIMESTAMP(3) WHERE id = ?', [firmId]).catch(() => {
    /* best effort — see above */
  });
}

// ── Readout ──────────────────────────────────────────────────────────────────

/** Entry counts, surfaced on /health so the caches are not invisible. */
export function cacheSizes(): Record<string, number> {
  return {
    sessions: sessions.size,
    firms: firmRows.size,
    members: members.size,
    markers: markers.size,
  };
}
