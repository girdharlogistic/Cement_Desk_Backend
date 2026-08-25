import { PoolConnection } from 'mysql2/promise';
import { q, qOne, tx } from '../../db/pool';
import { errors } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { sqlToIso, addSecondsSql, parseBusinessDate } from '../../lib/dates';
import { num } from '../../lib/num';
import { validateFreightEntry, FreightInput } from '../../lib/validators';
import { sha256Hex } from '../../lib/tokens';
import { syncMeta } from '../../plugins/guards';

export interface FreightWrite extends FreightInput {
  id?: string;
  date: string; // yyyy-MM-dd
  partyId: string;
  locationId: string;
  vehicleNo: string;
  otherNote: string;
}

export function mapFreightEntry(r: any, gradeBags?: Record<string, number>): any {
  return {
    id: r.id,
    firmId: r.firm_id,
    serial: Number(r.serial),
    date: r.date, // DATE → 'yyyy-MM-dd' string
    partyId: r.party_id,
    locationId: r.location_id,
    vehicleNo: r.vehicle_no,
    revenuePerBag: num(r.revenue_per_bag),
    bags: num(r.bags),
    totalReimbursed: num(r.total_reimbursed),
    basis: r.basis,
    costRate: num(r.cost_rate),
    costUnits: num(r.cost_units),
    otherExpenses: num(r.other_expenses),
    otherNote: r.other_note ?? '',
    totalCost: num(r.total_cost),
    profit: num(r.profit),
    gradeBags: gradeBags ?? {},
    ...syncMeta(r),
  };
}

export async function fetchEntry(firmId: string, id: string, includeGrades = true): Promise<any | null> {
  const row = await qOne<any>('SELECT * FROM freight_entries WHERE firm_id = ? AND id = ?', [firmId, id]);
  if (!row) return null;
  const gb = includeGrades ? await gradeBagsFor(firmId, [id]) : {};
  return mapFreightEntry(row, gb[id] ?? {});
}

export async function gradeBagsFor(firmId: string, entryIds: string[]): Promise<Record<string, Record<string, number>>> {
  if (!entryIds.length) return {};
  const rows = await q<any>(
    `SELECT entry_id, grade_id, bags FROM freight_entry_grades WHERE firm_id = ? AND entry_id IN (${entryIds.map(() => '?').join(',')})`,
    [firmId, ...entryIds],
  );
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    (out[r.entry_id] ??= {})[r.grade_id] = num(r.bags);
  }
  return out;
}

/**
 * §5.1 serial allocation: per-firm, monotonic, never reused. LAST_INSERT_ID
 * trick makes the increment atomic under concurrency on TiDB/MySQL.
 */
async function allocateSerial(c: PoolConnection, firmId: string): Promise<number> {
  const [upd]: any = await c.query(
    'UPDATE firm_counters SET freight_serial = LAST_INSERT_ID(freight_serial + 1) WHERE firm_id = ?',
    [firmId],
  );
  if (upd.affectedRows === 0) {
    await c.query('INSERT INTO firm_counters (firm_id, freight_serial) VALUES (?, LAST_INSERT_ID(1))', [firmId]);
  }
  const [rows] = await c.query('SELECT LAST_INSERT_ID() AS s');
  return Number((rows as any[])[0].s);
}

/** Used by the import path (§5.1 / ensureSerialAtLeast). */
export async function ensureSerialAtLeast(c: PoolConnection, firmId: string, maxSerial: number): Promise<void> {
  await c.query('INSERT IGNORE INTO firm_counters (firm_id, freight_serial) VALUES (?, 0)', [firmId]);
  await c.query('UPDATE firm_counters SET freight_serial = GREATEST(freight_serial, ?) WHERE firm_id = ?', [
    maxSerial,
    firmId,
  ]);
}

async function writeGradeBags(
  c: PoolConnection,
  firmId: string,
  entryId: string,
  gradeBags: Record<string, number>,
): Promise<void> {
  await c.query('DELETE FROM freight_entry_grades WHERE firm_id = ? AND entry_id = ?', [firmId, entryId]);
  for (const [gradeId, bags] of Object.entries(gradeBags)) {
    await c.query('INSERT INTO freight_entry_grades (firm_id, entry_id, grade_id, bags) VALUES (?,?,?,?)', [
      firmId,
      entryId,
      gradeId,
      bags,
    ]);
  }
}

export async function createEntry(firmId: string, userId: string, data: FreightWrite): Promise<any> {
  validateFreightEntry(data);
  const id = data.id ?? newId();
  await checkRefs(firmId, data);
  // NOTE: the read-back deliberately happens *after* the transaction commits.
  // `fetchEntry` goes through the pool, and asking the pool for a second
  // connection while this one is still held deadlocks the pool as soon as there
  // are `connectionLimit` concurrent writers.
  await tx(async (c) => {
    const existing = await fetchEntryOn(c, firmId, id);
    if (existing && existing.deleted_at === null) {
      // Client id reuse: idempotent insert (§1.2) — leave the existing row alone.
      return;
    }
    if (existing) {
      // Tombstoned id: resurrect in place — re-inserting would collide on the
      // PK. Its old serial has since been handed to whatever moved down to
      // fill the gap (§5.1 compaction), so this needs a fresh one, not the one
      // it had before.
      const serial = await allocateSerial(c, firmId);
      await c.query(
        `UPDATE freight_entries SET date=?, party_id=?, location_id=?, vehicle_no=?, revenue_per_bag=?, bags=?,
           total_reimbursed=?, basis=?, cost_rate=?, cost_units=?, other_expenses=?, other_note=?, total_cost=?,
           profit=?, deleted_at = NULL, serial = ?, rev = rev + 1, updated_by = ?
         WHERE firm_id = ? AND id = ?`,
        [data.date, data.partyId, data.locationId, data.vehicleNo, data.revenuePerBag, data.bags,
         data.totalReimbursed, data.basis, data.costRate, data.costUnits, data.otherExpenses, data.otherNote,
         data.totalCost, data.profit, serial, userId, firmId, id],
      );
      await writeGradeBags(c, firmId, id, data.gradeBags ?? {});
      return;
    }
    const serial = await allocateSerial(c, firmId);
    await insertEntryRow(c, firmId, id, serial, data, userId);
    await writeGradeBags(c, firmId, id, data.gradeBags ?? {});
  });
  return (await fetchEntry(firmId, id))!;
}

async function fetchEntryOn(c: PoolConnection, firmId: string, id: string): Promise<any | null> {
  const [rows] = await c.query('SELECT * FROM freight_entries WHERE firm_id = ? AND id = ?', [firmId, id]);
  return (rows as any[])[0] ?? null;
}

async function insertEntryRow(
  c: PoolConnection,
  firmId: string,
  id: string,
  serial: number,
  d: FreightWrite,
  userId: string,
): Promise<void> {
  await c.query(
    `INSERT INTO freight_entries
       (firm_id, id, serial, date, party_id, location_id, vehicle_no, revenue_per_bag, bags,
        total_reimbursed, basis, cost_rate, cost_units, other_expenses, other_note, total_cost, profit, updated_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      firmId, id, serial, d.date, d.partyId, d.locationId, d.vehicleNo, d.revenuePerBag, d.bags,
      d.totalReimbursed, d.basis, d.costRate, d.costUnits, d.otherExpenses, d.otherNote, d.totalCost, d.profit, userId,
    ],
  );
}

async function checkRefs(firmId: string, d: FreightWrite): Promise<void> {
  const p = await qOne('SELECT id FROM parties WHERE firm_id = ? AND id = ? AND deleted_at IS NULL', [firmId, d.partyId]);
  if (!p) throw errors.validation('Unknown party', [{ field: 'partyId', code: 'NOT_FOUND', message: 'Party not found' }]);
  const l = await qOne('SELECT id FROM locations WHERE firm_id = ? AND id = ? AND deleted_at IS NULL', [firmId, d.locationId]);
  if (!l) throw errors.validation('Unknown location', [{ field: 'locationId', code: 'NOT_FOUND', message: 'Location not found' }]);
}

export async function patchEntry(
  firmId: string,
  userId: string,
  id: string,
  patch: Partial<FreightWrite>,
  ifMatch: number | null,
): Promise<any> {
  const existing = await qOne<any>('SELECT * FROM freight_entries WHERE firm_id = ? AND id = ?', [firmId, id]);
  if (!existing || existing.deleted_at) throw errors.notFound('Entry not found');
  if (ifMatch !== null && Number(existing.rev) !== ifMatch) throw errors.revMismatch(mapFreightEntry(existing));

  const merged: FreightWrite = {
    date: existing.date,
    partyId: existing.party_id,
    locationId: existing.location_id,
    vehicleNo: existing.vehicle_no,
    revenuePerBag: num(existing.revenue_per_bag),
    bags: num(existing.bags),
    totalReimbursed: num(existing.total_reimbursed),
    basis: existing.basis,
    costRate: num(existing.cost_rate),
    costUnits: num(existing.cost_units),
    otherExpenses: num(existing.other_expenses),
    otherNote: existing.other_note ?? '',
    totalCost: num(existing.total_cost),
    profit: num(existing.profit),
    gradeBags: undefined,
    ...patch,
  };
  validateFreightEntry(merged);
  await checkRefs(firmId, merged);

  await tx(async (c) => {
    const colMap: Record<string, [string, unknown]> = {
      date: ['date', merged.date],
      partyId: ['party_id', merged.partyId],
      locationId: ['location_id', merged.locationId],
      vehicleNo: ['vehicle_no', merged.vehicleNo],
      revenuePerBag: ['revenue_per_bag', merged.revenuePerBag],
      bags: ['bags', merged.bags],
      totalReimbursed: ['total_reimbursed', merged.totalReimbursed],
      basis: ['basis', merged.basis],
      costRate: ['cost_rate', merged.costRate],
      costUnits: ['cost_units', merged.costUnits],
      otherExpenses: ['other_expenses', merged.otherExpenses],
      otherNote: ['other_note', merged.otherNote],
      totalCost: ['total_cost', merged.totalCost],
      profit: ['profit', merged.profit],
    };
    const touched = Object.keys(patch).filter((k) => k in colMap && k !== 'id');
    const sets = touched.map((k) => `${colMap[k][0]} = ?`);
    const vals = touched.map((k) => colMap[k][1]);
    if (sets.length) {
      await c.query(
        `UPDATE freight_entries SET ${sets.join(', ')}, rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ?`,
        [...vals, userId, firmId, id],
      );
    }
    if (patch.gradeBags !== undefined) {
      await writeGradeBags(c, firmId, id, patch.gradeBags ?? {});
      if (!sets.length) {
        await c.query('UPDATE freight_entries SET rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ?', [
          userId,
          firmId,
          id,
        ]);
      }
    }
  });
  return (await fetchEntry(firmId, id))!;
}

/**
 * §5.1 compaction: once an entry is gone, every later entry in the same firm
 * shifts down by one serial, so the visible sequence is always 1..N with no
 * hole to explain. Order matters — shifting low-to-high never collides with
 * the (firm_id, serial_live) unique key, because by the time a row's target
 * value is written, the row that used to hold it has already moved off it.
 * (Tombstones never enter into this: `serial_live` is a generated column that
 * reads NULL once `deleted_at` is set, so a deleted row's old number stops
 * blocking anything the instant it dies, however many times it gets reused
 * afterwards.) `rev` and `updated_at` are bumped on every shifted row so the
 * change reaches already-synced devices through the ordinary cursor pull
 * (§9.2), the same as any other edit.
 */
export async function compactSerialsAfterDelete(
  c: PoolConnection,
  firmId: string,
  deletedSerial: number,
  userId: string,
): Promise<void> {
  const [rows] = await c.query(
    'SELECT id FROM freight_entries WHERE firm_id = ? AND serial > ? AND deleted_at IS NULL ORDER BY serial ASC',
    [firmId, deletedSerial],
  );
  for (const r of rows as any[]) {
    await c.query(
      'UPDATE freight_entries SET serial = serial - 1, rev = rev + 1, updated_at = UTC_TIMESTAMP(3), updated_by = ? WHERE firm_id = ? AND id = ?',
      [userId, firmId, r.id],
    );
  }
  // Whether or not anything was above it, one fewer serial is now in use.
  await c.query('UPDATE firm_counters SET freight_serial = GREATEST(freight_serial - 1, 0) WHERE firm_id = ?', [
    firmId,
  ]);
}

export async function deleteEntry(firmId: string, userId: string, id: string): Promise<void> {
  await tx(async (c) => {
    const [rows] = await c.query(
      'SELECT serial FROM freight_entries WHERE firm_id = ? AND id = ? AND deleted_at IS NULL',
      [firmId, id],
    );
    const row = (rows as any[])[0];
    if (!row) return; // already gone — nothing to tombstone or compact
    const serial = Number(row.serial);
    await c.query(
      'UPDATE freight_entries SET deleted_at = UTC_TIMESTAMP(3), rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ?',
      [userId, firmId, id],
    );
    await compactSerialsAfterDelete(c, firmId, serial, userId);
  });
}

export async function listEntries(
  firmId: string,
  opts: { from?: string; to?: string; partyId?: string; locationId?: string; limit: number; cursor?: { date: string; id: string } },
): Promise<{ rows: any[]; nextCursor: string | null }> {
  const clauses = ['firm_id = ?', 'deleted_at IS NULL'];
  const params: unknown[] = [firmId];
  if (opts.from) {
    clauses.push('date >= ?');
    params.push(opts.from);
  }
  if (opts.to) {
    clauses.push('date <= ?');
    params.push(opts.to);
  }
  if (opts.partyId) {
    clauses.push('party_id = ?');
    params.push(opts.partyId);
  }
  if (opts.locationId) {
    clauses.push('location_id = ?');
    params.push(opts.locationId);
  }
  if (opts.cursor) {
    // Keyset pagination, newest first (date, id) DESC.
    clauses.push('(date < ? OR (date = ? AND id < ?))');
    params.push(opts.cursor.date, opts.cursor.date, opts.cursor.id);
  }
  const rows = await q<any>(
    `SELECT * FROM freight_entries WHERE ${clauses.join(' AND ')} ORDER BY date DESC, id DESC LIMIT ?`,
    [...params, opts.limit + 1],
  );
  let nextCursor: string | null = null;
  if (rows.length > opts.limit) {
    rows.length = opts.limit;
    const last = rows[rows.length - 1];
    nextCursor = Buffer.from(JSON.stringify({ d: last.date, i: last.id })).toString('base64url');
  }
  const gb = await gradeBagsFor(firmId, rows.map((r) => r.id));
  return { rows: rows.map((r) => mapFreightEntry(r, gb[r.id] ?? {})), nextCursor };
}

/** §8.5 summary — pure aggregates over stored columns (never re-derived). */
export async function summary(firmId: string, from?: string, to?: string, partyId?: string): Promise<any> {
  const clauses = ['firm_id = ?', 'deleted_at IS NULL'];
  const params: unknown[] = [firmId];
  if (from) {
    clauses.push('date >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('date <= ?');
    params.push(to);
  }
  if (partyId) {
    clauses.push('party_id = ?');
    params.push(partyId);
  }
  const where = clauses.join(' AND ');
  const [tot] = await q<any>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(total_reimbursed),0) AS tr, COALESCE(SUM(total_cost),0) AS tc,
            COALESCE(SUM(profit),0) AS p, COALESCE(SUM(bags),0) AS b
       FROM freight_entries WHERE ${where}`,
    params,
  );
  const byLoc = await q<any>(
    `SELECT location_id, COUNT(*) AS n, COALESCE(SUM(total_reimbursed),0) AS tr,
            COALESCE(SUM(total_cost),0) AS tc, COALESCE(SUM(profit),0) AS p, COALESCE(SUM(bags),0) AS b
       FROM freight_entries WHERE ${where} GROUP BY location_id ORDER BY p DESC`,
    params,
  );
  const locNames = byLoc.length
    ? await q<any>(`SELECT id, name FROM locations WHERE firm_id = ? AND id IN (${byLoc.map(() => '?').join(',')})`, [
        firmId,
        ...byLoc.map((l) => l.location_id),
      ])
    : [];
  const nameOf = new Map(locNames.map((l) => [l.id, l.name]));
  const pack = (r: any) => ({
    entryCount: Number(r.n),
    bags: num(r.b),
    totalReimbursed: num(r.tr),
    totalCost: num(r.tc),
    netProfit: num(r.p),
    profitPerBag: num(r.b) > 0 ? num(r.p) / num(r.b) : 0,
  });
  return {
    // `tot` is already the first row — `q` returns rows, and the destructuring
    // above unwrapped it. Indexing it again yields undefined and 500s the route.
    ...pack(tot),
    byLocation: byLoc.map((l) => ({ locationId: l.location_id, locationName: nameOf.get(l.location_id) ?? null, ...pack(l) })),
  };
}

// ------------------------------------------------------------- idempotency

/** §8.1 idempotency wrapper for POSTs that create data. */
export async function withIdempotency<T>(
  userId: string,
  endpoint: string,
  key: string | undefined,
  fn: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T }> {
  if (!key) return fn();
  const keyHash = sha256Hex(`${userId}:${endpoint}:${key}`);
  const existing = await qOne<any>('SELECT response_code, response_body FROM idempotency_keys WHERE key_hash = ?', [keyHash]);
  if (existing) {
    const body =
      typeof existing.response_body === 'string' ? JSON.parse(existing.response_body) : existing.response_body;
    return { status: Number(existing.response_code), body: body as T };
  }
  const out = await fn();
  try {
    await q('INSERT INTO idempotency_keys (key_hash, user_id, endpoint, response_code, response_body) VALUES (?,?,?,?,CAST(? AS JSON))', [
      keyHash,
      userId,
      endpoint,
      out.status,
      JSON.stringify(out.body ?? null),
    ]);
  } catch {
    /* concurrent replay raced us — the first stored response wins; acceptable */
  }
  return out;
}

export function businessDateOr400(v: unknown, field: string): string {
  const d = parseBusinessDate(v);
  if (!d) throw errors.validation(`Invalid date for ${field}`, [{ field, code: 'INVALID_DATE', message: 'Use yyyy-MM-dd' }]);
  return d;
}

export { sqlToIso, addSecondsSql };
