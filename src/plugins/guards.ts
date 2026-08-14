import { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAccessToken } from '../lib/tokens';
import { errors } from '../lib/errors';
import { qOne } from '../db/pool';
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

  const session = await qOne<{
    id: string;
    user_id: string;
    revoked_at: string | null;
    expires_at: string;
  }>('SELECT id, user_id, revoked_at, expires_at FROM sessions WHERE id = ?', [sid]);
  if (!session) throw errors.unauthenticated('Unknown session');
  if (session.revoked_at) throw errors.tokenRevoked();
  if (session.expires_at <= sqlNowForCompare()) throw errors.tokenExpired();

  req.userId = sub;
  req.sessionId = sid;
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
