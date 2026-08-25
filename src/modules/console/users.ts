import { q, qOne } from '../../db/pool';
import { entitlementOf } from '../plans/service';
import { readEntitlement } from '../plans/repo';
import { Features } from '../plans/features';
import { sqlToIso } from '../../lib/dates';

/** Tables the console reads live counts from — every one is a fixed literal
 * below, never something built from a request, so interpolating the name is
 * safe (mysql2 can only parameterise values, not identifiers). */
type TenantTable = 'freight_entries' | 'stock_days' | 'purchases' | 'schemes' | 'claims';

export interface UserListRow {
  id: string;
  email: string;
  displayName: string;
  phone: string | null;
  emailVerified: boolean;
  status: string;
  createdAt: string;
  firmsOwned: number;
  firmsMember: number;
  lastActiveAt: string | null;
}

/**
 * A page of users, newest first, optionally filtered by email/name/phone.
 * `search` is matched with `LIKE '%…%'` against three columns — this table is
 * sized for a console an operator scrolls, not an autocomplete, so an index
 * miss here costs nothing that matters.
 */
export async function listUsers(opts: {
  search?: string;
  limit: number;
  offset: number;
}): Promise<{ rows: UserListRow[]; total: number }> {
  const term = opts.search?.trim();
  const where = term ? 'WHERE u.email_norm LIKE ? OR u.display_name LIKE ? OR u.phone LIKE ?' : '';
  const like = `%${term ?? ''}%`;
  const whereParams = term ? [like.toLowerCase(), like, like] : [];

  const totalRow = await qOne<{ n: number }>(`SELECT COUNT(*) AS n FROM users u ${where}`, whereParams);

  const rows = await q<any>(
    `SELECT u.id, u.email, u.display_name, u.phone, u.email_verified, u.status, u.created_at,
       (SELECT COUNT(*) FROM firms f WHERE f.owner_user_id = u.id AND f.deleted_at IS NULL) AS firms_owned,
       (SELECT COUNT(*) FROM firm_members fm WHERE fm.user_id = u.id) AS firms_member,
       (SELECT MAX(last_used_at) FROM sessions s WHERE s.user_id = u.id) AS last_active_at
     FROM users u
     ${where}
     ORDER BY u.created_at DESC
     LIMIT ? OFFSET ?`,
    [...whereParams, opts.limit, opts.offset],
  );

  return {
    total: Number(totalRow?.n ?? 0),
    rows: rows.map((r) => ({
      id: r.id,
      email: r.email,
      displayName: r.display_name ?? '',
      phone: r.phone,
      emailVerified: Boolean(r.email_verified),
      status: r.status,
      createdAt: sqlToIso(r.created_at)!,
      firmsOwned: Number(r.firms_owned),
      firmsMember: Number(r.firms_member),
      lastActiveAt: r.last_active_at ? sqlToIso(r.last_active_at) : null,
    })),
  };
}

async function perFirmCounts(table: TenantTable, firmIds: string[]): Promise<Record<string, number>> {
  if (!firmIds.length) return {};
  const rows = await q<{ firm_id: string; n: number }>(
    `SELECT firm_id, COUNT(*) AS n FROM ${table} WHERE firm_id IN (?) AND deleted_at IS NULL GROUP BY firm_id`,
    [firmIds],
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.firm_id] = Number(r.n);
  return out;
}

export interface UserDetail {
  id: string;
  email: string;
  phone: string | null;
  displayName: string;
  emailVerified: boolean;
  status: string;
  createdAt: string;
  updatedAt: string;
  firms: {
    id: string;
    name: string;
    role: string;
    owned: boolean;
    entries: number;
    stockDays: number;
    purchases: number;
    schemes: number;
    claims: number;
  }[];
  sessions: {
    deviceLabel: string;
    userAgent: string;
    createdAt: string;
    lastUsedAt: string;
    expiresAt: string;
    revoked: boolean;
  }[];
  totals: { firms: number; entries: number; stockDays: number; purchases: number; schemes: number; claims: number };
  entitlement: {
    planId: string | null;
    planName: string;
    source: string;
    status: string;
    expiresAt: string | null;
    features: Features;
    note: string;
    grandfatheredFirms: number | null;
    grandfatheredDevices: number | null;
  };
}

/** Everything the console shows about one user. Null if the id does not exist. */
export async function getUserDetail(userId: string): Promise<UserDetail | null> {
  const user = await qOne<any>('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return null;

  const memberships = await q<any>(
    `SELECT f.id, f.name, fm.role, f.owner_user_id
     FROM firm_members fm JOIN firms f ON f.id = fm.firm_id
     WHERE fm.user_id = ? AND f.deleted_at IS NULL
     ORDER BY f.created_at`,
    [userId],
  );
  const firmIds = memberships.map((m: any) => m.id as string);

  const [entries, stockDays, purchases, schemes, claims] = await Promise.all([
    perFirmCounts('freight_entries', firmIds),
    perFirmCounts('stock_days', firmIds),
    perFirmCounts('purchases', firmIds),
    perFirmCounts('schemes', firmIds),
    perFirmCounts('claims', firmIds),
  ]);

  const firms = memberships.map((m: any) => ({
    id: m.id as string,
    name: m.name as string,
    role: m.role as string,
    owned: m.owner_user_id === userId,
    entries: entries[m.id] ?? 0,
    stockDays: stockDays[m.id] ?? 0,
    purchases: purchases[m.id] ?? 0,
    schemes: schemes[m.id] ?? 0,
    claims: claims[m.id] ?? 0,
  }));

  const totals = firms.reduce(
    (acc, f) => ({
      firms: acc.firms + 1,
      entries: acc.entries + f.entries,
      stockDays: acc.stockDays + f.stockDays,
      purchases: acc.purchases + f.purchases,
      schemes: acc.schemes + f.schemes,
      claims: acc.claims + f.claims,
    }),
    { firms: 0, entries: 0, stockDays: 0, purchases: 0, schemes: 0, claims: 0 },
  );

  const sessionRows = await q<any>(
    `SELECT device_label, user_agent, created_at, last_used_at, expires_at, revoked_at
     FROM sessions WHERE user_id = ? ORDER BY last_used_at DESC LIMIT 20`,
    [userId],
  );

  // Both halves: the resolved entitlement is what the user actually gets right
  // now, the raw row is what an operator needs to see to understand *why* —
  // whether it was granted or bought, and what grandfathering is attached.
  const entitlement = await entitlementOf(userId);
  const entitlementRow = await readEntitlement(userId);

  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    displayName: user.display_name ?? '',
    emailVerified: Boolean(user.email_verified),
    status: user.status,
    createdAt: sqlToIso(user.created_at)!,
    updatedAt: sqlToIso(user.updated_at)!,
    firms,
    totals,
    sessions: sessionRows.map((s: any) => ({
      deviceLabel: s.device_label ?? '',
      userAgent: s.user_agent ?? '',
      createdAt: sqlToIso(s.created_at)!,
      lastUsedAt: sqlToIso(s.last_used_at)!,
      expiresAt: sqlToIso(s.expires_at)!,
      revoked: s.revoked_at !== null,
    })),
    entitlement: {
      planId: entitlement.planId,
      planName: entitlement.planName,
      source: entitlement.source,
      status: entitlement.status,
      expiresAt: entitlement.expiresAt,
      features: entitlement.features,
      note: entitlementRow?.note ?? '',
      grandfatheredFirms: entitlementRow?.grandfatheredFirms ?? null,
      grandfatheredDevices: entitlementRow?.grandfatheredDevices ?? null,
    },
  };
}

export interface Analytics {
  totalUsers: number;
  verifiedUsers: number;
  activeUsers7d: number;
  activeUsers30d: number;
  totalFirms: number;
  totalEntries: number;
  totalStockDays: number;
  totalPurchases: number;
  totalSchemes: number;
  totalClaims: number;
  signupsByDay: { date: string; n: number }[];
  topFirms: { id: string; name: string; ownerEmail: string; entries: number }[];
}

/** Fills the last [days] calendar days (UTC, inclusive of today) with 0 where
 * a sparse GROUP BY has no row, so the bar row the console draws has no gaps. */
function fillDays(rows: { d: string; n: number }[], days: number): { date: string; n: number }[] {
  const map = new Map(rows.map((r) => [String(r.d), Number(r.n)]));
  const today = new Date();
  const out: { date: string; n: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    out.push({ date: key, n: map.get(key) ?? 0 });
  }
  return out;
}

/** Platform-wide numbers for the "Users & analysis" tab. Every count excludes
 * soft-deleted rows; "active" means a session was used, not merely issued. */
export async function analytics(): Promise<Analytics> {
  const totals = await qOne<any>(
    `SELECT
       (SELECT COUNT(*) FROM users) AS totalUsers,
       (SELECT COUNT(*) FROM users WHERE email_verified = 1) AS verifiedUsers,
       (SELECT COUNT(DISTINCT user_id) FROM sessions WHERE last_used_at >= UTC_TIMESTAMP(3) - INTERVAL 7 DAY) AS active7,
       (SELECT COUNT(DISTINCT user_id) FROM sessions WHERE last_used_at >= UTC_TIMESTAMP(3) - INTERVAL 30 DAY) AS active30,
       (SELECT COUNT(*) FROM firms WHERE deleted_at IS NULL) AS totalFirms,
       (SELECT COUNT(*) FROM freight_entries WHERE deleted_at IS NULL) AS totalEntries,
       (SELECT COUNT(*) FROM stock_days WHERE deleted_at IS NULL) AS totalStockDays,
       (SELECT COUNT(*) FROM purchases WHERE deleted_at IS NULL) AS totalPurchases,
       (SELECT COUNT(*) FROM schemes WHERE deleted_at IS NULL) AS totalSchemes,
       (SELECT COUNT(*) FROM claims WHERE deleted_at IS NULL) AS totalClaims`,
  );

  const signupRows = await q<{ d: string; n: number }>(
    `SELECT DATE(created_at) AS d, COUNT(*) AS n FROM users
     WHERE created_at >= UTC_TIMESTAMP(3) - INTERVAL 30 DAY
     GROUP BY DATE(created_at) ORDER BY d`,
  );

  const topFirmsRows = await q<any>(
    `SELECT f.id, f.name, u.email AS owner_email,
       (SELECT COUNT(*) FROM freight_entries fe WHERE fe.firm_id = f.id AND fe.deleted_at IS NULL) AS entries
     FROM firms f JOIN users u ON u.id = f.owner_user_id
     WHERE f.deleted_at IS NULL
     ORDER BY entries DESC
     LIMIT 10`,
  );

  return {
    totalUsers: Number(totals?.totalUsers ?? 0),
    verifiedUsers: Number(totals?.verifiedUsers ?? 0),
    activeUsers7d: Number(totals?.active7 ?? 0),
    activeUsers30d: Number(totals?.active30 ?? 0),
    totalFirms: Number(totals?.totalFirms ?? 0),
    totalEntries: Number(totals?.totalEntries ?? 0),
    totalStockDays: Number(totals?.totalStockDays ?? 0),
    totalPurchases: Number(totals?.totalPurchases ?? 0),
    totalSchemes: Number(totals?.totalSchemes ?? 0),
    totalClaims: Number(totals?.totalClaims ?? 0),
    signupsByDay: fillDays(signupRows.map((r) => ({ d: r.d, n: r.n })), 30),
    topFirms: topFirmsRows.map((r: any) => ({
      id: r.id,
      name: r.name,
      ownerEmail: r.owner_email,
      entries: Number(r.entries),
    })),
  };
}
