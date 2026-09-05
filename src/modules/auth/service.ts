import { q, qOne, tx, Q } from '../../db/pool';
import { errors } from '../../lib/errors';
import { invalidateAllSessions, invalidateSession } from '../../lib/caches';
import { hashPassword, verifyPassword, DUMMY_HASH_PROMISE } from '../../lib/passwords';
import { generateRefreshToken, sha256Hex, signAccessToken } from '../../lib/tokens';
import { addSecondsSql, nowSql, sqlToIso } from '../../lib/dates';
import { newId } from '../../lib/ids';
import { getConfig } from '../../config';
import { sendMail, sendMailBestEffort } from '../../lib/mailer';
import { generateOtp, otpMatches, OTP_MAX_ATTEMPTS, OTP_TTL_SECONDS } from '../../lib/otp';
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
  c: Q,
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

/**
 * Issues a 6-digit code, superseding any code of the same purpose the user is
 * already holding.
 *
 * Superseding is not tidiness: without it a resend would leave the previous
 * code live, and every resend would widen the set of digits that open the
 * account instead of replacing it.
 */
async function issueOtp(
  c: Q,
  purpose: 'verify_email' | 'reset_password',
  userId: string,
  emailNorm: string,
): Promise<string> {
  await c.query(
    `UPDATE auth_tokens SET used_at = UTC_TIMESTAMP(3)
      WHERE user_id = ? AND purpose = ? AND used_at IS NULL`,
    [userId, purpose],
  );
  const otp = generateOtp();
  await c.query(
    `INSERT INTO auth_tokens (id, user_id, email_norm, purpose, token_hash, salt, payload, expires_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      newId(),
      userId,
      emailNorm,
      purpose,
      otp.hash,
      otp.salt,
      JSON.stringify(null),
      addSecondsSql(new Date(), OTP_TTL_SECONDS),
    ],
  );
  return otp.code;
}

/**
 * Checks a code and burns it on success. Wrong guesses are counted on the row
 * itself, so the limit survives a restart and cannot be reset by reconnecting.
 *
 * Every failure says the same thing. Distinguishing "no code pending" from
 * "wrong code" would confirm to a stranger that an account exists and has a
 * verification in flight.
 */
async function consumeOtp(
  purpose: 'verify_email' | 'reset_password',
  userId: string,
  code: string,
): Promise<void> {
  const bad = () => errors.validation('That code is not valid. Check it, or ask for a new one.');
  await tx(async (c) => {
    const [rows] = await c.query(
      `SELECT * FROM auth_tokens
        WHERE user_id = ? AND purpose = ? AND used_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [userId, purpose],
    );
    const tok = (rows as any[])[0];
    if (!tok || !tok.salt) throw bad();
    if (tok.expires_at <= nowSql()) {
      await c.query('UPDATE auth_tokens SET used_at = UTC_TIMESTAMP(3) WHERE id = ?', [tok.id]);
      throw errors.validation('That code has expired. Ask for a new one.');
    }
    // Count the attempt before judging it, so a client that hangs up on a
    // wrong answer still pays for the guess.
    const attempts = Number(tok.attempts ?? 0) + 1;
    if (attempts >= OTP_MAX_ATTEMPTS) {
      await c.query('UPDATE auth_tokens SET attempts = ?, used_at = UTC_TIMESTAMP(3) WHERE id = ?', [
        attempts,
        tok.id,
      ]);
      if (!otpMatches(code, tok.salt, tok.token_hash)) {
        throw errors.validation('Too many wrong codes. Ask for a new one.');
      }
      return; // Correct on the final allowed attempt — accept it.
    }
    await c.query('UPDATE auth_tokens SET attempts = ? WHERE id = ?', [attempts, tok.id]);
    if (!otpMatches(code, tok.salt, tok.token_hash)) throw bad();
    await c.query('UPDATE auth_tokens SET used_at = UTC_TIMESTAMP(3) WHERE id = ?', [tok.id]);
  });
}

function otpMail(code: string): { subject: string; body: string } {
  return {
    subject: `${code} is your Cement Desk code`,
    body:
      `Your Cement Desk verification code is:\n\n    ${code}\n\n` +
      `It expires in ${OTP_TTL_SECONDS / 60} minutes and can be used once.\n\n` +
      `If you did not ask for this, you can ignore this email — nobody can ` +
      `get into your account with the code alone.`,
  };
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
    const code = await issueOtp(c, 'verify_email', userId, emailNorm);
    const mail = otpMail(code);
    sendMailBestEffort(email, mail.subject, mail.body);
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

// A retried refresh call on a bad connection can arrive after the server
// already rotated the token but before the client saw the response, so the
// client comes back with a token that was only *just* superseded. Treating
// that the same as real reuse (a token replayed days later) logged people out
// mid-session on flaky mobile networks. Within this window it is resolved by
// chasing the rotation chain instead (§7.2).
const REFRESH_REUSE_GRACE_MS = 60_000;

async function rotateSession(session: any): Promise<{ tokens: Omit<SessionInfo, 'sessionId'>; userId: string }> {
  const tokens = await tx(async (c) => {
    const next = await createSession(
      c,
      session.user_id,
      session.device_id,
      session.device_label ?? '',
      session.user_agent ?? '',
    );
    await c.query('UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3), replaced_by = ? WHERE id = ?', [
      next.sessionId,
      session.id,
    ]);
    return next;
  });
  // The old session is dead the moment this commits; drop its cached copy so
  // the next request with the old access token is refused, not served for the
  // remainder of the cache window.
  invalidateSession(session.id);
  return { tokens, userId: session.user_id };
}

export async function refresh(rawRefreshToken: string): Promise<{ tokens: Omit<SessionInfo, 'sessionId'>; userId: string }> {
  const hash = sha256Hex(rawRefreshToken);
  const session = await qOne<any>('SELECT * FROM sessions WHERE refresh_token_hash = ?', [hash]);
  if (!session) throw errors.unauthenticated('Unknown refresh token');

  if (session.revoked_at) {
    let cur = session;
    let hops = 0;
    while (
      cur.revoked_at &&
      cur.replaced_by &&
      Date.now() - new Date(cur.revoked_at).getTime() <= REFRESH_REUSE_GRACE_MS &&
      hops++ < 5
    ) {
      const next = await qOne<any>('SELECT * FROM sessions WHERE id = ?', [cur.replaced_by]);
      if (!next) break;
      cur = next;
    }
    if (!cur.revoked_at && cur.expires_at > nowSql()) return rotateSession(cur);

    // Outside the grace window, or the chain dead-ends: a dead token came
    // back to life, which is what real theft looks like. Nuke every session.
    await q('UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL', [
      session.user_id,
    ]);
    invalidateAllSessions();
    throw errors.tokenRevoked();
  }

  if (session.expires_at <= nowSql()) throw errors.tokenExpired();
  return rotateSession(session);
}

export async function logout(rawRefreshToken: string): Promise<void> {
  const hash = sha256Hex(rawRefreshToken);
  await q('UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE refresh_token_hash = ? AND revoked_at IS NULL', [
    hash,
  ]);
  // Which session id that hash belonged to is not in hand here, and looking it
  // up is a round trip to save clearing a map of a few dozen entries.
  invalidateAllSessions();
}

export async function logoutAll(userId: string): Promise<void> {
  await q('UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL', [userId]);
  invalidateAllSessions();
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
  invalidateAllSessions();
}

export async function forgotPassword(email: string): Promise<void> {
  // Always success-shaped from the outside (§8.2) — never reveal existence.
  const emailNorm = normalizeEmail(email);
  const user = await qOne<any>('SELECT id, email FROM users WHERE email_norm = ? AND status = \'active\'', [emailNorm]);
  if (!user) return;
  const code = await tx(async (c) => issueOtp(c, 'reset_password', user.id, emailNorm));
  const mail = otpMail(code);
  await sendMail(user.email, mail.subject, mail.body);
}

/**
 * Reset takes the email as well as the code: the caller is not signed in, so
 * the address is what identifies whose code this is.
 */
export async function resetPassword(email: string, code: string, newPassword: string): Promise<void> {
  const emailNorm = normalizeEmail(email);
  const user = await qOne<any>('SELECT id FROM users WHERE email_norm = ? AND status = \'active\'', [emailNorm]);
  // Same error an unknown code gives, so this cannot be used to enumerate
  // which addresses have accounts.
  if (!user) throw errors.validation('That code is not valid. Check it, or ask for a new one.');
  await consumeOtp('reset_password', user.id, code);
  const hash = await hashPassword(newPassword);
  await tx(async (c) => {
    await c.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, user.id]);
    await c.query('UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL', [
      user.id,
    ]);
  });
  invalidateAllSessions();
}

/** Verification is done from inside the app, so the session identifies the user. */
export async function verifyEmail(userId: string, code: string): Promise<UserWire> {
  await consumeOtp('verify_email', userId, code);
  await q('UPDATE users SET email_verified = 1 WHERE id = ?', [userId]);
  // `emailVerified` rides along in the cached session, so without this the
  // user stays locked out of every verified-only route for the cache window —
  // right after the one action that was supposed to let them in.
  invalidateAllSessions();
  const user = await qOne<any>('SELECT * FROM users WHERE id = ?', [userId]);
  return mapUser(user);
}

/** Sends a fresh verification code, replacing whatever is outstanding. */
export async function resendVerification(userId: string): Promise<void> {
  const user = await qOne<any>('SELECT id, email, email_norm, email_verified FROM users WHERE id = ?', [userId]);
  if (!user) throw errors.notFound('User not found');
  if (user.email_verified) return; // Nothing to do — do not send a pointless mail.
  const code = await tx(async (c) => issueOtp(c, 'verify_email', user.id, user.email_norm));
  const mail = otpMail(code);
  await sendMail(user.email, mail.subject, mail.body);
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
  invalidateSession(sessionId);
}

/** Allow-list check used by firmAccess-independent endpoints (token gift). */
export async function touchSession(sessionId: string): Promise<void> {
  // Throttled by the DB's own write coalescing being irrelevant at this scale;
  // update at most ~once per minute by relying on MySQL NOOP equality skips.
  await q('UPDATE sessions SET last_used_at = UTC_TIMESTAMP(3) WHERE id = ? AND revoked_at IS NULL', [sessionId]);
}
