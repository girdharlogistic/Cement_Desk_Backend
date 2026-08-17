import { q, qOne } from '../../db/pool';
import { errors } from '../../lib/errors';
import { isoToSql, sqlToIso, addDaysSql } from '../../lib/dates';
import { getConfig } from '../../config';
import { mapMasterRow, mapRoute } from '../masters/routes';
import { mapFreightEntry, gradeBagsFor } from '../freight/service';
import { mapStockDay } from '../stock/service';
import { mapPurchase, paymentsFor } from '../landing/purchases';
import { mapScheme } from '../landing/schemes';
import { mapClaim } from '../landing/claims';
import { num } from '../../lib/num';

export interface PullResult {
  serverTime: string;
  nextCursor: string;
  hasMore: boolean;
  changes: Record<string, unknown[] | null>;
}

/**
 * Cursor-based pull (§9.2). Scan window is (cursor, upperBound]; upperBound is
 * captured from the DB clock up front so rows committed mid-request can never
 * be skipped. nextCursor = max updated_at actually returned; falls back to the
 * upper bound when a page is empty.
 */
export async function pull(
  firmId: string,
  userId: string,
  cursorIso: string | undefined,
  limit: number,
  deviceId?: string,
): Promise<PullResult> {
  const cfg = getConfig();
  let cursorSql: string | null = null;
  if (cursorIso) {
    cursorSql = isoToSql(cursorIso);
    if (!cursorSql) throw errors.validation('Invalid cursor');
    const oldest = addDaysSql(new Date(), -cfg.TOMBSTONE_RETENTION_DAYS);
    if (cursorSql < oldest) throw errors.cursorTooOld();
  } else {
    cursorSql = '1970-01-01 00:00:00.000';
  }
  const upper = ((await qOne<{ u: string }>('SELECT UTC_TIMESTAMP(3) AS u'))!).u;

  const changes: Record<string, unknown[] | null> = {};
  let hasMore = false;
  let maxReturned: string | null = null;
  // Each table paginates independently, so a table truncated at `limit` may stop
  // at an earlier instant than another table's last row. Advancing the cursor to
  // the global max would skip the truncated table's remaining rows forever, so the
  // cursor is capped at the earliest truncation point. Rows past that cap are
  // simply re-sent on the next page — upserts are idempotent on the client.
  const truncated: { floor: string | null } = { floor: null };

  /**
   * `tieBreak` keeps the ordering total when several rows share an updated_at.
   * It is a column name, never user input. `opening_baselines` is keyed on
   * firm_id alone and has no `id` column at all — ordering it by `id` made every
   * single pull fail with ER_BAD_FIELD_ERROR.
   */
  async function page(table: string, tieBreak = 'id'): Promise<any[]> {
    const rows = await q<any>(
      `SELECT * FROM ${table} WHERE firm_id = ? AND updated_at > ? AND updated_at <= ? ORDER BY updated_at ASC, ${tieBreak} ASC LIMIT ?`,
      [firmId, cursorSql, upper, limit + 1],
    );
    if (rows.length > limit) {
      hasMore = true;
      rows.length = limit;
      const lastKept = rows[rows.length - 1].updated_at as string;
      if (truncated.floor === null || lastKept < truncated.floor) truncated.floor = lastKept;
    }
    for (const r of rows) if (!maxReturned || r.updated_at > maxReturned) maxReturned = r.updated_at;
    return rows;
  }

  // masters
  changes.parties = (await page('parties')).map((r) => mapMasterRow('parties', r));
  changes.locations = (await page('locations')).map((r) => mapMasterRow('locations', r));
  changes.grades = (await page('grades')).map((r) => mapMasterRow('grades', r));
  changes.routes = (await page('party_routes')).map(mapRoute);
  changes.companies = (await page('companies')).map((r) => mapMasterRow('companies', r));
  changes.sources = (await page('sources')).map((r) => mapMasterRow('sources', r));

  // freight (children inlined)
  const fe = await page('freight_entries');
  const feGrades = await gradeBagsFor(firmId, fe.filter((r) => !r.deleted_at).map((r) => r.id));
  changes.freightEntries = fe.map((r) => mapFreightEntry(r, feGrades[r.id] ?? {}));

  // baseline: at most one row per firm
  const bl = await page('opening_baselines', 'firm_id');
  if (bl.length === 0) {
    changes.baseline = null;
  } else {
    const h = bl[0];
    const stock = await q<any>('SELECT * FROM opening_baseline_stock WHERE firm_id = ?', [firmId]);
    const pty = await q<any>('SELECT * FROM opening_baseline_party WHERE firm_id = ?', [firmId]);
    const physical: Record<string, number> = {};
    const sap: Record<string, number> = {};
    for (const s of stock) { physical[s.grade_id] = num(s.physical); sap[s.grade_id] = num(s.sap); }
    const party: Record<string, Record<string, number>> = {};
    for (const p of pty) ((party[p.party_id] ??= {})[p.grade_id] = num(p.x_qty));
    changes.baseline = {
      firmId: h.firm_id, date: h.date, physical, sap, party,
      rev: Number(h.rev), createdAt: sqlToIso(h.created_at), updatedAt: sqlToIso(h.updated_at),
      deletedAt: sqlToIso(h.deleted_at), updatedBy: h.updated_by ?? null,
    } as any;
  }

  // stock days (receipts + sparse cells inlined)
  const sd = await page('stock_days');
  const sdIds = sd.filter((r) => !r.deleted_at).map((r) => r.id);
  let receipts: any[] = []; let cells: any[] = [];
  if (sdIds.length) {
    const ph = sdIds.map(() => '?').join(',');
    [receipts, cells] = await Promise.all([
      q<any>(`SELECT * FROM stock_receipts WHERE firm_id = ? AND stock_day_id IN (${ph})`, [firmId, ...sdIds]),
      q<any>(`SELECT * FROM stock_day_cells WHERE firm_id = ? AND stock_day_id IN (${ph})`, [firmId, ...sdIds]),
    ]);
  }
  changes.stockDays = sd.map((r) =>
    mapStockDay(r, receipts.filter((x) => x.stock_day_id === r.id), cells.filter((x) => x.stock_day_id === r.id)),
  );

  // landing
  const pu = await page('purchases');
  const puPayments = await paymentsFor(null, firmId, pu.filter((r) => !r.deleted_at).map((r) => r.id));
  changes.purchases = pu.map((r) => mapPurchase(r, puPayments));

  const sc = await page('schemes');
  const scIds = sc.filter((r) => !r.deleted_at).map((r) => r.id);
  let slabs: any[] = []; let premium: any[] = [];
  if (scIds.length) {
    const ph = scIds.map(() => '?').join(',');
    [slabs, premium] = await Promise.all([
      q<any>(`SELECT * FROM scheme_slabs WHERE firm_id = ? AND scheme_id IN (${ph}) ORDER BY slab_from ASC`, [firmId, ...scIds]),
      q<any>(`SELECT * FROM scheme_premium_grades WHERE firm_id = ? AND scheme_id IN (${ph})`, [firmId, ...scIds]),
    ]);
  }
  changes.schemes = sc.map((r) => mapScheme(r, slabs, premium));

  const cl = await page('claims');
  const clIds = cl.filter((r) => !r.deleted_at).map((r) => r.id);
  let notes: any[] = [];
  if (clIds.length) {
    notes = await q<any>(
      `SELECT * FROM claim_credit_notes WHERE firm_id = ? AND claim_id IN (${clIds.map(() => '?').join(',')})`,
      [firmId, ...clIds],
    );
  }
  changes.claims = cl.map((r) => mapClaim(r, notes));

  // Cap at the earliest truncation point (see `page`). The cap must still make
  // forward progress: if a single table has more than `limit` rows sharing one
  // millisecond, the floor collapses onto the incoming cursor and the client
  // would re-request the same page forever — fall back to the max returned then,
  // which is the best a millisecond-granular cursor can do.
  let nextCursorSql = maxReturned ?? upper;
  if (truncated.floor !== null && truncated.floor > cursorSql && truncated.floor < nextCursorSql) {
    nextCursorSql = truncated.floor;
  }
  const result: PullResult = {
    serverTime: sqlToIso(upper)!,
    nextCursor: sqlToIso(nextCursorSql)!,
    hasMore,
    changes,
  };

  if (deviceId) {
    await q(
      `INSERT INTO sync_state (user_id, device_id, firm_id, \`cursor\`, last_sync_at) VALUES (?,?,?,?,UTC_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE \`cursor\` = VALUES(\`cursor\`), last_sync_at = UTC_TIMESTAMP(3)`,
      [userId, deviceId, firmId, nextCursorSql],
    );
  }
  return result;
}
