import { PoolConnection } from 'mysql2/promise';
import { q, qOne, tx } from '../../db/pool';
import { errors } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { num } from '../../lib/num';
import { syncMeta } from '../../plugins/guards';

export interface BaselineInput {
  date: string;
  physical: Record<string, number>;
  sap: Record<string, number>;
  party: Record<string, Record<string, number>>;
}

export function mapStockDay(r: any, receipts: any[], cells: any[]): any {
  const rows: Record<string, Record<string, { billing: number; dispatch: number }>> = {};
  for (const c of cells) {
    const billing = num(c.billing);
    const dispatch = num(c.dispatch);
    if (billing === 0 && dispatch === 0) continue; // sparsity (§6.6)
    ((rows[c.party_id] ??= {})[c.grade_id] = { billing, dispatch });
  }
  return {
    id: r.id,
    firmId: r.firm_id,
    date: r.date,
    clientKey: `${r.firm_id}|${r.date}`, // client natural key (§1.2 / §9.6)
    receipts: receipts.map((x) => ({
      id: x.id,
      gradeId: x.grade_id,
      qty: num(x.qty),
      sapQty: num(x.sap_qty),
      ref: x.ref ?? '',
    })),
    rows,
    ...syncMeta(r),
  };
}

export async function getDayRow(firmId: string, date: string): Promise<any | null> {
  return qOne('SELECT * FROM stock_days WHERE firm_id = ? AND date = ? AND deleted_at IS NULL', [firmId, date]);
}

export async function fetchDayByRow(c: PoolConnection, row: any): Promise<any> {
  const [receiptsRes, cellsRes] = await Promise.all([
    c.query('SELECT * FROM stock_receipts WHERE firm_id = ? AND stock_day_id = ?', [row.firm_id, row.id]),
    c.query('SELECT * FROM stock_day_cells WHERE firm_id = ? AND stock_day_id = ?', [row.firm_id, row.id]),
  ]);
  return mapStockDay(row, receiptsRes[0] as any[], cellsRes[0] as any[]);
}

export async function getBaseline(firmId: string): Promise<any> {
  const header = await qOne<any>('SELECT * FROM opening_baselines WHERE firm_id = ? AND deleted_at IS NULL', [firmId]);
  if (!header) throw errors.notFound('No opening baseline set for this firm');
  const stock = await q<any>('SELECT * FROM opening_baseline_stock WHERE firm_id = ?', [firmId]);
  const party = await q<any>('SELECT * FROM opening_baseline_party WHERE firm_id = ?', [firmId]);
  const physical: Record<string, number> = {};
  const sap: Record<string, number> = {};
  for (const s of stock) {
    physical[s.grade_id] = num(s.physical);
    sap[s.grade_id] = num(s.sap);
  }
  const partyMap: Record<string, Record<string, number>> = {};
  for (const p of party) ((partyMap[p.party_id] ??= {})[p.grade_id] = num(p.x_qty));
  return { firmId, date: header.date, physical, sap, party: partyMap, ...syncMeta(header) };
}

/**
 * One baseline per firm (§3.7); PUT replaces it wholesale (upsert + children).
 * Response carries affectedDayCount so the client can warn (§5.2).
 */
export async function putBaseline(
  firmId: string,
  userId: string,
  input: BaselineInput,
): Promise<{ baseline: any; affectedDayCount: number }> {
  // Moving the baseline on/after existing days would silently invalidate them
  // (days are only valid strictly after the baseline date) — refuse instead.
  const invalid = await q<{ n: number }>(
    'SELECT COUNT(*) AS n FROM stock_days WHERE firm_id = ? AND deleted_at IS NULL AND date <= ?',
    [firmId, input.date],
  );
  if (Number(invalid[0].n) > 0) {
    throw errors.businessRule(
      `${invalid[0].n} stock day(s) fall on/before the new baseline date; delete or move them first`,
    );
  }

  const header = await tx(async (c) => {
    const [existing] = await c.query('SELECT firm_id, deleted_at FROM opening_baselines WHERE firm_id = ? FOR UPDATE', [firmId]);
    if ((existing as any[]).length) {
      await c.query(
        'UPDATE opening_baselines SET date = ?, deleted_at = NULL, rev = rev + 1, updated_by = ? WHERE firm_id = ?',
        [input.date, userId, firmId],
      );
    } else {
      await c.query('INSERT INTO opening_baselines (firm_id, date, updated_by) VALUES (?,?,?)', [firmId, input.date, userId]);
    }
    await c.query('DELETE FROM opening_baseline_stock WHERE firm_id = ?', [firmId]);
    await c.query('DELETE FROM opening_baseline_party WHERE firm_id = ?', [firmId]);
    const gradeIds = new Set([...Object.keys(input.physical), ...Object.keys(input.sap)]);
    for (const g of gradeIds) {
      await c.query('INSERT INTO opening_baseline_stock (firm_id, grade_id, physical, sap) VALUES (?,?,?,?)', [
        firmId, g, input.physical[g] ?? 0, input.sap[g] ?? 0,
      ]);
    }
    for (const [partyId, grades] of Object.entries(input.party)) {
      for (const [gradeId, xQty] of Object.entries(grades)) {
        await c.query('INSERT INTO opening_baseline_party (firm_id, party_id, grade_id, x_qty) VALUES (?,?,?,?)', [
          firmId, partyId, gradeId, xQty,
        ]);
      }
    }
    return true;
  });
  void header;

  const affected = await q<{ n: number }>(
    'SELECT COUNT(*) AS n FROM stock_days WHERE firm_id = ? AND deleted_at IS NULL AND date > ?',
    [firmId, input.date],
  );
  return { baseline: await getBaseline(firmId), affectedDayCount: Number(affected[0].n) };
}

export async function createStockDay(firmId: string, userId: string, date: string): Promise<any> {
  const baseline = await qOne<any>('SELECT date FROM opening_baselines WHERE firm_id = ? AND deleted_at IS NULL', [firmId]);
  if (!baseline || date <= baseline.date) throw errors.dayBeforeBaseline();
  const live = await getDayRow(firmId, date);
  if (live) throw errors.stockDayExists();

  return tx(async (c) => {
    const [tomb] = await c.query('SELECT id FROM stock_days WHERE firm_id = ? AND date = ? AND deleted_at IS NOT NULL FOR UPDATE', [firmId, date]);
    let row: any;
    if ((tomb as any[]).length) {
      // Resurrect the tombstoned sheet in place (§6.3b).
      const id = (tomb as any[])[0].id;
      await c.query('UPDATE stock_days SET deleted_at = NULL, rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ?', [userId, firmId, id]);
      const [r] = await c.query('SELECT * FROM stock_days WHERE firm_id = ? AND id = ?', [firmId, id]);
      row = (r as any[])[0];
    } else {
      const id = newId();
      await c.query('INSERT INTO stock_days (firm_id, id, date, updated_by) VALUES (?,?,?,?)', [firmId, id, date, userId]);
      const [r] = await c.query('SELECT * FROM stock_days WHERE firm_id = ? AND id = ?', [firmId, id]);
      row = (r as any[])[0];
    }
    return fetchDayByRow(c, row);
  });
}

export async function getStockDay(firmId: string, date: string): Promise<any> {
  const row = await getDayRow(firmId, date);
  if (!row) throw errors.notFound('No stock sheet for this date');
  const [receipts, cells] = await Promise.all([
    q<any>('SELECT * FROM stock_receipts WHERE firm_id = ? AND stock_day_id = ?', [firmId, row.id]),
    q<any>('SELECT * FROM stock_day_cells WHERE firm_id = ? AND stock_day_id = ?', [firmId, row.id]),
  ]);
  return mapStockDay(row, receipts, cells);
}

export async function listStockDays(firmId: string, from?: string, to?: string): Promise<any[]> {
  const clauses = ['firm_id = ?', 'deleted_at IS NULL'];
  const params: unknown[] = [firmId];
  if (from) { clauses.push('date >= ?'); params.push(from); }
  if (to) { clauses.push('date <= ?'); params.push(to); }
  const days = await q<any>(`SELECT * FROM stock_days WHERE ${clauses.join(' AND ')} ORDER BY date ASC`, params);
  if (!days.length) return [];
  const ids = days.map((d) => d.id);
  const ph = ids.map(() => '?').join(',');
  const [receipts, cells] = await Promise.all([
    q<any>(`SELECT * FROM stock_receipts WHERE firm_id = ? AND stock_day_id IN (${ph})`, [firmId, ...ids]),
    q<any>(`SELECT * FROM stock_day_cells WHERE firm_id = ? AND stock_day_id IN (${ph})`, [firmId, ...ids]),
  ]);
  return days.map((d) =>
    mapStockDay(d, receipts.filter((x) => x.stock_day_id === d.id), cells.filter((x) => x.stock_day_id === d.id)),
  );
}

async function bumpDay(c: PoolConnection, firmId: string, dayId: string, userId: string): Promise<void> {
  await c.query('UPDATE stock_days SET rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ?', [userId, firmId, dayId]);
}

/** §6.6 sparsity: a {0,0} cell is deleted, never stored. */
export async function putCell(
  firmId: string,
  userId: string,
  date: string,
  cell: { partyId: string; gradeId: string; billing: number; dispatch: number },
): Promise<any> {
  const day = await getDayRow(firmId, date);
  if (!day) throw errors.notFound('No stock sheet for this date');
  await tx(async (c) => {
    if (cell.billing === 0 && cell.dispatch === 0) {
      await c.query(
        'DELETE FROM stock_day_cells WHERE firm_id = ? AND stock_day_id = ? AND party_id = ? AND grade_id = ?',
        [firmId, day.id, cell.partyId, cell.gradeId],
      );
    } else {
      await c.query(
        `INSERT INTO stock_day_cells (firm_id, stock_day_id, party_id, grade_id, billing, dispatch)
         VALUES (?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE billing = VALUES(billing), dispatch = VALUES(dispatch)`,
        [firmId, day.id, cell.partyId, cell.gradeId, cell.billing, cell.dispatch],
      );
    }
    await bumpDay(c, firmId, day.id, userId);
  });
  return getStockDay(firmId, date);
}

export async function addReceipt(
  firmId: string,
  userId: string,
  date: string,
  r: { id?: string; gradeId: string; qty: number; sapQty: number; ref: string },
): Promise<any> {
  const day = await getDayRow(firmId, date);
  if (!day) throw errors.notFound('No stock sheet for this date');
  const id = r.id ?? newId();
  await tx(async (c) => {
    await c.query(
      `INSERT INTO stock_receipts (firm_id, id, stock_day_id, grade_id, qty, sap_qty, ref)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE qty = VALUES(qty), sap_qty = VALUES(sap_qty), ref = VALUES(ref)`,
      [firmId, id, day.id, r.gradeId, r.qty, r.sapQty, r.ref],
    );
    await bumpDay(c, firmId, day.id, userId);
  });
  return getStockDay(firmId, date);
}

export async function deleteReceipt(firmId: string, userId: string, date: string, receiptId: string): Promise<any> {
  const day = await getDayRow(firmId, date);
  if (!day) throw errors.notFound('No stock sheet for this date');
  await tx(async (c) => {
    await c.query('DELETE FROM stock_receipts WHERE firm_id = ? AND id = ? AND stock_day_id = ?', [firmId, receiptId, day.id]);
    await bumpDay(c, firmId, day.id, userId);
  });
  return getStockDay(firmId, date);
}

export async function deleteStockDay(firmId: string, userId: string, date: string): Promise<void> {
  const day = await getDayRow(firmId, date);
  if (!day) return; // idempotent
  await q('UPDATE stock_days SET deleted_at = UTC_TIMESTAMP(3), rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ?', [
    userId, firmId, day.id,
  ]);
}

/** Touch a day's rev/updated_at (shared with sync). */
export async function touchDay(firmId: string, dayId: string, userId: string): Promise<void> {
  await q('UPDATE stock_days SET rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ?', [userId, firmId, dayId]);
}
