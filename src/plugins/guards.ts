import { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAccessToken } from '../lib/tokens';
import { errors } from '../lib/errors';
import { q, qOne } from '../db/pool';
import { Role, ROLE_RANK } from '../types';
import { sqlToIso } from '../lib/dates';

/**
 * Bearer-token authentication (§7.2). Loads the session row so that revoked
 * sessions are rejected immediately (TOKEN_REVOKED), and refreshes last_used_at
 * lazily (best effort, throttled to ~1/min/session).
 */
export async function authenticate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) throw errors.unauthenticated();
  const token = header.slice('Bearer '.length).trim();
  const { sub, sid } = await verifyAccessToken(token);

  // Joined rather than fetched separately: `requireVerified` runs on almost
  // every route, and paying a second round trip per request to read one
  // TINYINT would be silly.
  const session = await qOne<{
    id: string;
    user_id: string;
    revoked_at: string | null;
    expires_at: string;
    email_verified: number;
  }>(
    `SELECT s.id, s.user_id, s.revoked_at, s.expires_at, u.email_verified
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`,
    [sid],
  );
  if (!session) throw errors.unauthenticated('Unknown session');
  if (session.revoked_at) throw errors.tokenRevoked();
  if (session.expires_at <= sqlNowForCompare()) throw errors.tokenExpired();

  req.userId = sub;
  req.sessionId = sid;
  req.emailVerified = !!session.email_verified;
  touchLastUsed(sid);
}

/**
 * Everything but `/auth/*` is closed to an account that has not confirmed its
 * email. The app enforces the same rule with its OTP screen, but that gate
 * lives in an APK anyone can modify — this is the one that counts.
 */
export async function requireVerified(req: FastifyRequest): Promise<void> {
  if (!req.emailVerified) throw errors.emailNotVerified();
}

/**
 * `authenticate` plus the verification gate. Every route outside the auth
 * module uses this; the auth module uses bare `authenticate`, because an
 * unverified user must still be able to reach verify-email and resend.
 */
export async function authenticateVerified(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await authenticate(req, reply);
  await requireVerified(req);
}

/**
 * Lazy `last_used_at` refresh, throttled to ~1/min/session and fire-and-forget so
 * the request never waits on it (and a failure never fails the request). Without
 * this, `GET /auth/sessions` would order every session by its creation time.
 */
const lastTouched = new Map<string, number>();
const TOUCH_INTERVAL_MS = 60_000;

function touchLastUsed(sessionId: string): void {
  const now = Date.now();
  const prev = lastTouched.get(sessionId);
  if (prev !== undefined && now - prev < TOUCH_INTERVAL_MS) return;
  lastTouched.set(sessionId, now);
  if (lastTouched.size > 10_000) {
    for (const [k, t] of lastTouched) if (now - t > TOUCH_INTERVAL_MS) lastTouched.delete(k);
  }
  void q('UPDATE sessions SET last_used_at = UTC_TIMESTAMP(3) WHERE id = ? AND revoked_at IS NULL', [
    sessionId,
  ]).catch(() => {
    /* best effort — never fail a request over a bookkeeping write */
  });
}

function sqlNowForCompare(): string {
  // sessions.expires_at is DATETIME(3) UTC in dateStrings mode.
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`
  );
}

/**
 * Tenancy resolution (§7.3): firm_id comes from the route, never the body.
 * Verifies membership and attaches firmId/firmRole to the request. Hard rule:
 * every tenant query afterwards must include `firm_id = ?`.
 */
export async function firmAccess(req: FastifyRequest): Promise<void> {
  const firmId = (req.params as any)?.firmId;
  if (typeof firmId !== 'string' || firmId.length === 0) throw errors.notFound();
  const firm = await qOne<{ id: string; deleted_at: string | null }>(
    'SELECT id, deleted_at FROM firms WHERE id = ?',
    [firmId],
  );
  if (!firm || firm.deleted_at) {
    // Do not leak the distinction between "no firm" and "not a member".
    const m = firm ? await member(firmId, req.userId) : null;
    if (!m) throw errors.notAFirmMember();
    throw errors.notFound('Firm not found');
  }
  const m = await member(firmId, req.userId);
  if (!m) throw errors.notAFirmMember();
  req.firmId = firmId;
  req.firmRole = m.role;
}

async function member(firmId: string, userId: string): Promise<{ role: Role } | null> {
  return qOne<{ role: Role }>('SELECT role FROM firm_members WHERE firm_id = ? AND user_id = ?', [
    firmId,
    userId,
  ]);
}

/** Role gate per the §7.3 matrix. */
export function requireRole(min: Role) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!req.firmRole || ROLE_RANK[req.firmRole] < ROLE_RANK[min]) {
      throw errors.insufficientRole();
    }
  };
}

/** Parse an If-Match revision header (optimistic concurrency, §8.1). */
export function ifMatchRev(req: FastifyRequest): number | null {
  const raw = req.headers['if-match'];
  if (raw === undefined) return null;
  const n = Number(String(raw).replace(/^"|"$/g, ''));
  if (!Number.isInteger(n) || n < 0) throw errors.validation('Invalid If-Match header');
  return n;
}

/** Convert a DB row's sync columns to wire form. */
export function syncMeta(row: {
  rev: string | number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  updated_by: string | null;
}) {
  return {
    rev: Number(row.rev),
    createdAt: sqlToIso(row.created_at),
    updatedAt: sqlToIso(row.updated_at),
    deletedAt: sqlToIso(row.deleted_at),
    updatedBy: row.updated_by ?? null,
  };
}
