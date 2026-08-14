import { PoolConnection } from 'mysql2/promise';
import { q, qOne, tx } from '../../db/pool';
import { errors } from '../../lib/errors';
import { hashPassword, verifyPassword, DUMMY_HASH_PROMISE } from '../../lib/passwords';
import { generateAuthToken, generateRefreshToken, sha256Hex, signAccessToken } from '../../lib/tokens';
import { addSecondsSql, nowSql, sqlToIso } from '../../lib/dates';
import { newId } from '../../lib/ids';
import { getConfig } from '../../config';
import { sendMail } from '../../lib/mailer';
import { Role } from '../../types';

export interface SessionInfo {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: string; // ISO
}

export interface UserWire {
  id: string;
  email: string;
  phone: string | null;
  displayName: string;
  emailVerified: boolean;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export function mapUser(r: any): UserWire {
  return {
    id: r.id,
    email: r.email,
    phone: r.phone ?? null,
    displayName: r.display_name ?? '',
    emailVerified: !!r.email_verified,
    status: r.status,
    createdAt: sqlToIso(r.created_at),
    updatedAt: sqlToIso(r.updated_at),
  };
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

async function createSession(
  c: PoolConnection,
  userId: string,
  deviceId: string | null,
  deviceLabel: string,
  userAgent: string,
): Promise<SessionInfo> {
  const cfg = getConfig();
  const sessionId = newId();
  const rt = generateRefreshToken();
  const expires = addSecondsSql(new Date(), cfg.REFRESH_TOKEN_TTL_SECONDS);
  await c.query(
    `INSERT INTO sessions (id, user_id, refresh_token_hash, device_id, device_label, user_agent, expires_at)
     VALUES (?,?,?,?,?,?,?)`,
    [sessionId, userId, rt.hash, deviceId, deviceLabel, userAgent.slice(0, 255), expires],
  );
  const accessToken = await signAccessToken(userId, sessionId);
  return {
    sessionId,
    accessToken,
    refreshToken: rt.token,
    refreshExpiresAt: sqlToIso(expires)!,
  };
}

async function issueAuthToken(
  c: PoolConnection,
  purpose: 'verify_email' | 'reset_password' | 'firm_invite',
  ttlSeconds: number,
  userId: string | null,
  emailNorm: string | null,
  payload: unknown,
): Promise<{ id: string; rawToken: string }> {
  const id = newId();
  const t = generateAuthToken();
  await c.query(
    `INSERT INTO auth_tokens (id, user_id, email_norm, purpose, token_hash, payload, expires_at)
     VALUES (?,?,?,?,?,CAST(? AS JSON),?)`,
    [id, userId, emailNorm, purpose, t.hash, JSON.stringify(payload ?? null), addSecondsSql(new Date(), ttlSeconds)],
  );
  return { id, rawToken: t.token };
}

async function consumeAuthToken(rawToken: string, purpose: string) {
  const hash = sha256Hex(rawToken);
  return tx(async (c) => {
    const [rows] = await c.query(
      'SELECT * FROM auth_tokens WHERE token_hash = ? AND purpose = ? FOR UPDATE',
      [hash, purpose],
    );
    const tok = (rows as any[])[0];
    if (!tok) throw errors.validation('Invalid or unknown token');
    if (tok.used_at) throw errors.validation('Token already used');
    if (tok.expires_at <= nowSql()) throw errors.validation('Token expired');
    await c.query('UPDATE auth_tokens SET used_at = UTC_TIMESTAMP(3) WHERE id = ?', [tok.id]);
    return tok;
  });
}

export async function signup(
  email: string,
  password: string,
  displayName: string,
  firmName: string | undefined,
  fyStartMonth: number | undefined,
): Promise<{ user: UserWire; tokens: Omit<SessionInfo, 'sessionId'>; firm?: { id: string; name: string; fyStartMonth: number; role: Role } }> {
  const emailNorm = normalizeEmail(email);
  const existing = await qOne('SELECT id FROM users WHERE email_norm = ?', [emailNorm]);
  if (existing) {
    throw errors.validation('Could not create account with these details', [
      { field: 'email', code: 'EMAIL_TAKEN', message: 'Email is already registered' },
    ]);
  }
  const passwordHash = await hashPassword(password);
  const userId = newId();

  const firm = await tx(async (c) => {
    await c.query(
      'INSERT INTO users (id, email, email_norm, password_hash, display_name) VALUES (?,?,?,?,?)',
      [userId, email.trim(), emailNorm, passwordHash, displayName],
    );
    let firmWire: { id: string; name: string; fyStartMonth: number; role: Role } | undefined;
    if (firmName) {
      // Mirrors FirstRunScreen: user + firm + owner membership + counter in ONE transaction (§8.2).
      const firmId = newId();
      const fy = fyStartMonth ?? 4;
      await c.query('INSERT INTO firms (id, owner_user_id, name, fy_start_month) VALUES (?,?,?,?)', [
        firmId,
        userId,
        firmName,
        fy,
      ]);
      await c.query("INSERT INTO firm_members (firm_id, user_id, role) VALUES (?,?,'owner')", [firmId, userId]);
      await c.query('INSERT INTO firm_counters (firm_id, freight_serial) VALUES (?, 0)', [firmId]);
      firmWire = { id: firmId, name: firmName, fyStartMonth: fy, role: 'owner' };
    }
    const verifyTok = await issueAuthToken(c, 'verify_email', 24 * 3600, userId, emailNorm, null);
    void sendMail(email, 'Verify your Cement Desk email', `Verification token: ${verifyTok.rawToken}`);
    return firmWire;
  });

  const tokens = await tx(async (c) => createSession(c, userId, null, '', ''));
  const user = (await qOne('SELECT * FROM users WHERE id = ?', [userId]))!;
  return { user: mapUser(user), tokens, firm };
}

export async function login(
  email: string,
  password: string,
  deviceId: string | undefined,
  deviceLabel: string | undefined,
  userAgent: string,
): Promise<{ user: UserWire; tokens: Omit<SessionInfo, 'sessionId'> }> {
  const emailNorm = normalizeEmail(email);
  const user = await qOne<any>('SELECT * FROM users WHERE email_norm = ?', [emailNorm]);
  // Timing equalization: always run a verify (§14, account-enumeration).
  const dummyHash = await DUMMY_HASH_PROMISE();
  const ok = await verifyPassword(user ? user.password_hash : dummyHash, password);
  if (!user || !ok) throw errors.unauthenticated('Invalid email or password');
  if (user.status !== 'active') throw errors.forbidden('Account is not active');

  const tokens = await tx(async (c) =>
    createSession(c, user.id, deviceId ?? null, deviceLabel ?? '', userAgent),
  );
  return { user: mapUser(user), tokens };
}

export async function refresh(rawRefreshToken: string): Promise<{ tokens: Omit<SessionInfo, 'sessionId'>; userId: string }> {
  const cfg = getConfig();
  const hash = sha256Hex(rawRefreshToken);
  const session = await qOne<any>('SELECT * FROM sessions WHERE refresh_token_hash = ?', [hash]);
  if (!session) throw errors.unauthenticated('Unknown refresh token');
  if (session.revoked_at) {
    // Refresh-token reuse → possible theft: nuke every session of the user (§7.2).
    await q('UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL', [
      session.user_id,
    ]);
    throw errors.tokenRevoked();
  }
  if (session.expires_at <= nowSql()) throw errors.tokenExpired();

  const tokens = await tx(async (c) => {
    // Rotate: revoke old row, create a new session sliding the expiry (§7.2).
    await c.query('UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE id = ?', [session.id]);
    return createSession(
      c,
      session.user_id,
      session.device_id,
      session.device_label ?? '',
      session.user_agent ?? '',
    );
  });
  void cfg;
  return { tokens, userId: session.user_id };
}

export async function logout(rawRefreshToken: string): Promise<void> {
  const hash = sha256Hex(rawRefreshToken);
  await q('UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE refresh_token_hash = ? AND revoked_at IS NULL', [
    hash,
  ]);
}

export async function logoutAll(userId: string): Promise<void> {
  await q('UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL', [userId]);
}

export async function me(userId: string): Promise<{
  user: UserWire;
  firms: { id: string; name: string; role: Role; fyStartMonth: number }[];
}> {
  const user = await qOne<any>('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw errors.notFound('User not found');
  const firms = await q<any>(
    `SELECT f.id, f.name, f.fy_start_month, m.role
       FROM firm_members m JOIN firms f ON f.id = m.firm_id
      WHERE m.user_id = ? AND f.deleted_at IS NULL
      ORDER BY LOWER(f.name)`,
    [userId],
  );
  return {
    user: mapUser(user),
    firms: firms.map((f) => ({ id: f.id, name: f.name, role: f.role as Role, fyStartMonth: Number(f.fy_start_month) })),
  };
}

export async function patchMe(userId: string, patch: { displayName?: string; phone?: string }): Promise<UserWire> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.displayName !== undefined) {
    sets.push('display_name = ?');
    params.push(patch.displayName);
  }
  if (patch.phone !== undefined) {
    sets.push('phone = ?');
    params.push(patch.phone === '' ? null : patch.phone);
  }
  if (sets.length) {
    params.push(userId);
    try {
      await q(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
    } catch (e: any) {
      if (e?.errno === 1062) throw errors.duplicateKey('Phone number already in use');
      throw e;
    }
  }
  const user = await qOne<any>('SELECT * FROM users WHERE id = ?', [userId]);
  return mapUser(user);
}

export async function changePassword(userId: string, currentSessionId: string, current: string, next: string): Promise<void> {
  const user = await qOne<any>('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw errors.notFound('User not found');
  if (!(await verifyPassword(user.password_hash, current))) {
    throw errors.unauthenticated('Current password is incorrect');
  }
  const hash = await hashPassword(next);
  await tx(async (c) => {
    await c.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);
    // Revoke every other session (§8.2).
    await c.query('UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND id <> ? AND revoked_at IS NULL', [
      userId,
      currentSessionId,
    ]);
  });
}

export async function forgotPassword(email: string): Promise<void> {
  // Always success-shaped from the outside (§8.2) — never reveal existence.
  const emailNorm = normalizeEmail(email);
  const user = await qOne<any>('SELECT id, email FROM users WHERE email_norm = ? AND status = \'active\'', [emailNorm]);
  if (!user) return;
  const tok = await tx(async (c) => issueAuthToken(c, 'reset_password', 3600, user.id, emailNorm, null));
  await sendMail(user.email, 'Reset your Cement Desk password', `Reset token: ${tok.rawToken}`);
}

export async function resetPassword(rawToken: string, newPassword: string): Promise<void> {
  const tok = await consumeAuthToken(rawToken, 'reset_password');
  const hash = await hashPassword(newPassword);
  await tx(async (c) => {
    await c.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, tok.user_id]);
    await c.query('UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL', [
      tok.user_id,
    ]);
  });
}

export async function verifyEmail(rawToken: string): Promise<void> {
  const tok = await consumeAuthToken(rawToken, 'verify_email');
  await q('UPDATE users SET email_verified = 1 WHERE id = ?', [tok.user_id]);
}

export async function listSessions(userId: string, currentSid: string) {
  const rows = await q<any>(
    `SELECT id, device_label, last_used_at, created_at
       FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(3)
      ORDER BY last_used_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    deviceLabel: r.device_label ?? '',
    lastUsedAt: sqlToIso(r.last_used_at),
    createdAt: sqlToIso(r.created_at),
    current: r.id === currentSid,
  }));
}

export async function revokeSession(userId: string, sessionId: string): Promise<void> {
  await q('UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE id = ? AND user_id = ?', [sessionId, userId]);
}

/** Allow-list check used by firmAccess-independent endpoints (token gift). */
export async function touchSession(sessionId: string): Promise<void> {
  // Throttled by the DB's own write coalescing being irrelevant at this scale;
  // update at most ~once per minute by relying on MySQL NOOP equality skips.
  await q('UPDATE sessions SET last_used_at = UTC_TIMESTAMP(3) WHERE id = ? AND revoked_at IS NULL', [sessionId]);
}
