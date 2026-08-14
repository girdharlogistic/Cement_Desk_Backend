import { PoolConnection } from 'mysql2/promise';
import { q, qOne, tx } from '../../db/pool';
import { errors } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { sqlToIso } from '../../lib/dates';
import { Role } from '../../types';
import { generateAuthToken, sha256Hex } from '../../lib/tokens';
import { addSecondsSql, nowSql } from '../../lib/dates';
import { sendMail } from '../../lib/mailer';

export interface FirmWire {
  id: string;
  name: string;
  fyStartMonth: number;
  role?: Role;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export function mapFirm(r: any, role?: Role): FirmWire {
  return {
    id: r.id,
    name: r.name,
    fyStartMonth: Number(r.fy_start_month),
    ...(role ? { role } : {}),
    createdAt: sqlToIso(r.created_at),
    updatedAt: sqlToIso(r.updated_at),
  };
}

/** Create firm + owner membership + serial counter in one transaction (§8.2/§8.3). */
export async function createFirmTx(
  c: PoolConnection,
  ownerUserId: string,
  name: string,
  fyStartMonth: number,
): Promise<FirmWire> {
  const id = newId();
  await c.query('INSERT INTO firms (id, owner_user_id, name, fy_start_month) VALUES (?,?,?,?)', [
    id,
    ownerUserId,
    name,
    fyStartMonth,
  ]);
  await c.query("INSERT INTO firm_members (firm_id, user_id, role) VALUES (?,?,'owner')", [id, ownerUserId]);
  await c.query('INSERT INTO firm_counters (firm_id, freight_serial) VALUES (?,0)', [id]);
  return { id, name, fyStartMonth, role: 'owner' };
}

export async function createFirm(userId: string, name: string, fyStartMonth = 4): Promise<FirmWire> {
  return tx(async (c) => createFirmTx(c, userId, name, fyStartMonth));
}

export async function listFirms(userId: string): Promise<FirmWire[]> {
  const rows = await q<any>(
    `SELECT f.*, m.role FROM firm_members m JOIN firms f ON f.id = m.firm_id
      WHERE m.user_id = ? AND f.deleted_at IS NULL ORDER BY LOWER(f.name)`,
    [userId],
  );
  return rows.map((r) => mapFirm(r, r.role as Role));
}

export async function patchFirm(
  firmId: string,
  patch: { name?: string; fyStartMonth?: number },
): Promise<FirmWire> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.fyStartMonth !== undefined) {
    sets.push('fy_start_month = ?');
    params.push(patch.fyStartMonth);
  }
  if (!sets.length) {
    return mapFirm((await qOne('SELECT * FROM firms WHERE id = ?', [firmId]))!);
  }
  await q(`UPDATE firms SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`, [...params, firmId]);
  const row = await qOne('SELECT * FROM firms WHERE id = ?', [firmId]);
  if (!row) throw errors.notFound('Firm not found');
  return mapFirm(row);
}

/**
 * Soft-delete the firm and every tenant row it owns (§5.6). Tombstones let
 * offline devices learn about the deletion on their next pull (§6.3).
 */
export async function deleteFirm(userId: string, firmId: string): Promise<void> {
  const firm = await qOne<any>('SELECT id, deleted_at FROM firms WHERE id = ?', [firmId]);
  if (!firm || firm.deleted_at) throw errors.notFound('Firm not found');

  const live = await q<{ n: number }>(
    `SELECT COUNT(*) AS n FROM firm_members m JOIN firms f ON f.id = m.firm_id
      WHERE m.user_id = ? AND f.deleted_at IS NULL`,
    [userId],
  );
  if (Number(live[0]?.n ?? 0) <= 1) throw errors.lastFirm();

  const TENANT_TABLES = [
    'parties',
    'locations',
    'grades',
    'party_routes',
    'freight_entries',
    'opening_baselines',
    'stock_days',
    'companies',
    'sources',
    'purchases',
    'schemes',
    'claims',
  ];
  await tx(async (c) => {
    for (const t of TENANT_TABLES) {
      await c.query(`UPDATE ${t} SET deleted_at = UTC_TIMESTAMP(3), rev = rev + 1 WHERE firm_id = ? AND deleted_at IS NULL`, [
        firmId,
      ]);
    }
    await c.query('DELETE FROM firm_members WHERE firm_id = ?', [firmId]);
    await c.query('DELETE FROM firm_counters WHERE firm_id = ?', [firmId]);
    await c.query('UPDATE firms SET deleted_at = UTC_TIMESTAMP(3) WHERE id = ?', [firmId]);
  });
}

// ---------------------------------------------------------------- members

export async function listMembers(firmId: string) {
  const rows = await q<any>(
    `SELECT m.user_id, m.role, u.email, u.display_name, m.created_at
       FROM firm_members m JOIN users u ON u.id = m.user_id
      WHERE m.firm_id = ? ORDER BY LOWER(u.email)`,
    [firmId],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    displayName: r.display_name ?? '',
    role: r.role as Role,
    createdAt: sqlToIso(r.created_at),
  }));
}

export async function inviteMember(
  firmId: string,
  email: string,
  role: Role,
  inviterUserId: string,
): Promise<{ inviteId: string }> {
  const emailNorm = email.trim().toLowerCase();
  const user = await qOne<any>('SELECT id FROM users WHERE email_norm = ?', [emailNorm]);
  if (user) {
    const existing = await qOne('SELECT user_id FROM firm_members WHERE firm_id = ? AND user_id = ?', [
      firmId,
      user.id,
    ]);
    if (existing) throw errors.duplicateKey('User is already a member of this firm');
  }
  const { createHash } = await import('crypto');
  void createHash;
  const raw = generateAuthToken();
  const id = newId();
  await q(
    `INSERT INTO auth_tokens (id, user_id, email_norm, purpose, token_hash, payload, expires_at)
     VALUES (?,?,?,?,?,CAST(? AS JSON),?)`,
    [id, null, emailNorm, 'firm_invite', raw.hash, JSON.stringify({ firmId, role, invitedBy: inviterUserId }), addSecondsSql(new Date(), 7 * 24 * 3600)],
  );
  await sendMail(email, 'You were invited to a Cement Desk firm', `Invite token: ${raw.token}`);
  return { inviteId: id };
}

export async function acceptInvite(userId: string, rawToken: string): Promise<FirmWire> {
  const hash = sha256Hex(rawToken);
  return tx(async (c) => {
    const [rows] = await c.query(
      "SELECT * FROM auth_tokens WHERE token_hash = ? AND purpose = 'firm_invite' FOR UPDATE",
      [hash],
    );
    const tok = (rows as any[])[0];
    if (!tok || tok.used_at || tok.expires_at <= nowSql()) {
      throw errors.validation('Invalid or expired invite token');
    }
    // Invites are addressed to an email; only that account may accept.
    const [urows] = await c.query('SELECT id, email, email_norm FROM users WHERE id = ?', [userId]);
    const u = (urows as any[])[0];
    if (!u || u.email_norm !== tok.email_norm) throw errors.forbidden('Invite is addressed to a different account');
    const payload = typeof tok.payload === 'string' ? JSON.parse(tok.payload) : tok.payload;
    const firmId: string = payload.firmId;
    const role: Role = payload.role === 'owner' ? 'member' : (payload.role ?? 'member'); // ownership is never granted via invite
    const [frows] = await c.query('SELECT * FROM firms WHERE id = ? AND deleted_at IS NULL', [firmId]);
    const firm = (frows as any[])[0];
    if (!firm) throw errors.notFound('Firm not found');
    await c.query('INSERT IGNORE INTO firm_members (firm_id, user_id, role) VALUES (?,?,?)', [firmId, userId, role]);
    await c.query('UPDATE auth_tokens SET used_at = UTC_TIMESTAMP(3) WHERE id = ?', [tok.id]);
    return mapFirm(firm, role);
  });
}

async function ownerCount(c: PoolConnection, firmId: string): Promise<number> {
  const [rows] = await c.query("SELECT COUNT(*) AS n FROM firm_members WHERE firm_id = ? AND role = 'owner'", [firmId]);
  return Number((rows as any[])[0].n);
}

export async function patchMemberRole(
  actorRole: Role,
  firmId: string,
  targetUserId: string,
  role: Role,
): Promise<void> {
  await tx(async (c) => {
    const [rows] = await c.query('SELECT role FROM firm_members WHERE firm_id = ? AND user_id = ? FOR UPDATE', [
      firmId,
      targetUserId,
    ]);
    const target = (rows as any[])[0];
    if (!target) throw errors.notFound('Member not found');
    // Only an owner may change another owner's role or grant ownership.
    if ((target.role === 'owner' || role === 'owner') && actorRole !== 'owner') {
      throw errors.insufficientRole();
    }
    if (target.role === 'owner' && role !== 'owner' && (await ownerCount(c, firmId)) <= 1) {
      throw errors.lastOwner();
    }
    await c.query('UPDATE firm_members SET role = ? WHERE firm_id = ? AND user_id = ?', [role, firmId, targetUserId]);
  });
}

export async function removeMember(actorRole: Role, actorUserId: string, firmId: string, targetUserId: string): Promise<void> {
  await tx(async (c) => {
    const [rows] = await c.query('SELECT role FROM firm_members WHERE firm_id = ? AND user_id = ? FOR UPDATE', [
      firmId,
      targetUserId,
    ]);
    const target = (rows as any[])[0];
    if (!target) throw errors.notFound('Member not found');
    if (target.role === 'owner') {
      if (actorRole !== 'owner' && actorUserId !== targetUserId) throw errors.insufficientRole();
      if ((await ownerCount(c, firmId)) <= 1) throw errors.lastOwner();
    }
    await c.query('DELETE FROM firm_members WHERE firm_id = ? AND user_id = ?', [firmId, targetUserId]);
  });
}
