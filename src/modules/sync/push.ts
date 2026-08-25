import { PoolConnection } from 'mysql2/promise';
import { tx } from '../../db/pool';
import { errors, isDuplicateKey, AppError } from '../../lib/errors';
import { isUuid, newId } from '../../lib/ids';
import { parseBusinessDate } from '../../lib/dates';
import { num } from '../../lib/num';
import { validateFreightEntry, validatePurchase, validateClaim, validateScheme, FreightInput } from '../../lib/validators';
import { MASTER_DEFS } from '../masters/routes';
import { deleteWithCascade, softDeleteRow } from '../masters/service';
import { mapFreightEntry, compactSerialsAfterDelete } from '../freight/service';
import { mapPurchase } from '../landing/purchases';
import { mapClaim } from '../landing/claims';
import { claimAutoStatus, sortSlabs } from '../../lib/validators';

export interface Mutation {
  op: 'upsert' | 'delete';
  entity: string;
  id: string;
  rev?: number;
  data?: any;
}

export interface PushOutcome {
  status: 'applied' | 'conflict' | 'rejected';
  entity: string;
  id: string;
  rev?: number;
  reason?: string;
  code?: string;
  message?: string;
  server?: any;
  serial?: number;
}

interface Ctx {
  c: PoolConnection;
  firmId: string;
  userId: string;
}

/** Per-group transaction, one per entity group (§9.3). */
export async function push(firmId: string, userId: string, mutations: Mutation[]): Promise<PushOutcome[]> {
  const GROUP_ORDER = [
    'grades', 'parties', 'locations', 'companies', 'sources', 'routes', 'baseline',
    'stockDays', 'freightEntries', 'schemes', 'purchases', 'purchasePayments', 'claims', 'claimCreditNotes',
  ];
  const byEntity = new Map<string, Mutation[]>();
  for (const m of mutations) {
    if (!byEntity.has(m.entity)) byEntity.set(m.entity, []);
    byEntity.get(m.entity)!.push(m);
  }
  const upsertGroups = GROUP_ORDER.filter((e) => byEntity.has(e) && byEntity.get(e)!.some((m) => m.op === 'upsert'))
    .map((e) => [e, byEntity.get(e)!.filter((m) => m.op === 'upsert')] as const);
  const deleteGroups = [...GROUP_ORDER].reverse()
    .filter((e) => byEntity.has(e) && byEntity.get(e)!.some((m) => m.op === 'delete'))
    .map((e) => [e, byEntity.get(e)!.filter((m) => m.op === 'delete')] as const);

  const outcomes: PushOutcome[] = [];
  for (const [entity, group] of [...upsertGroups, ...deleteGroups]) {
    try {
      const out = await tx(async (c) => {
        const ctx: Ctx = { c, firmId, userId };
        const inner: PushOutcome[] = [];
        for (const m of group) inner.push(await applyOne(ctx, m));
        return inner;
      });
      outcomes.push(...out);
    } catch (e: any) {
      // A group-level failure (e.g. deadlock) rejects every mutation in the group
      // without touching the others (§9.3).
      for (const m of group) {
        outcomes.push({ status: 'rejected', entity, id: m.id, code: 'GROUP_FAILED', message: String(e?.message ?? e) });
      }
    }
  }
  return outcomes;
}

async function applyOne(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  try {
    switch (m.entity) {
      case 'parties': case 'locations': case 'grades': case 'companies': case 'sources':
        return m.op === 'upsert' ? await masterUpsert(ctx, m) : await masterDelete(ctx, m);
      case 'routes': return m.op === 'upsert' ? await routeUpsert(ctx, m) : await routeDelete(ctx, m);
      case 'freightEntries': return m.op === 'upsert' ? await freightUpsert(ctx, m) : await freightDelete(ctx, m);
      case 'stockDays': return m.op === 'upsert' ? await stockDayUpsert(ctx, m) : await stockDayDelete(ctx, m);
      case 'baseline': return m.op === 'upsert' ? await baselineUpsert(ctx, m) : reject(m, 'NOT_SUPPORTED', 'Baseline cannot be deleted over sync');
      case 'purchases': return m.op === 'upsert' ? await purchaseUpsert(ctx, m) : await purchaseDelete(ctx, m);
      case 'purchasePayments': return m.op === 'upsert' ? await paymentUpsert(ctx, m) : await paymentDelete(ctx, m);
      case 'schemes': return m.op === 'upsert' ? await schemeUpsert(ctx, m) : await schemeDelete(ctx, m);
      case 'claims': return m.op === 'upsert' ? await claimUpsert(ctx, m) : await claimDelete(ctx, m);
      case 'claimCreditNotes': return m.op === 'upsert' ? await creditNoteUpsert(ctx, m) : await creditNoteDelete(ctx, m);
      default:
        return reject(m, 'UNKNOWN_ENTITY', `Unknown entity '${m.entity}'`);
    }
  } catch (e: any) {
    if (e instanceof AppError) {
      return reject(m, e.code, e.message);
    }
    return reject(m, 'INTERNAL', String(e?.message ?? e));
  }
}

const applied = (m: Mutation, rev: number): PushOutcome => ({ status: 'applied', entity: m.entity, id: m.id, rev });
const reject = (m: Mutation, code: string, message: string): PushOutcome => ({ status: 'rejected', entity: m.entity, id: m.id, code, message });
const conflict = (m: Mutation, reason: string, server: any): PushOutcome => ({ status: 'conflict', entity: m.entity, id: m.id, reason, server });

// ---------------------------------------------------------------- masters (LWW, §9.4)

async function masterUpsert(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  const def = MASTER_DEFS.find((d) => d.apiName === m.entity)!;
  if (!isUuid(m.id)) return reject(m, 'BAD_ID', 'id must be a UUID');
  const parsed = def.createSchema.partial().strip().safeParse(m.data ?? {});
  if (!parsed.success) return reject(m, 'VALIDATION_FAILED', parsed.error.issues.map((i: any) => i.message).join('; '));
  const cols = def.toCols(parsed.data);
  const [rows] = await ctx.c.query(`SELECT id, rev, deleted_at FROM ${def.table} WHERE firm_id = ? AND id = ? FOR UPDATE`, [ctx.firmId, m.id]);
  const existing = (rows as any[])[0];
  if (!existing) {
    if (!(parsed.data as any).name) return reject(m, 'VALIDATION_FAILED', 'name is required for new records');
    const colNames = Object.keys(cols);
    try {
      await ctx.c.query(
        `INSERT INTO ${def.table} (firm_id, id, ${colNames.join(',')}, updated_by) VALUES (?,?,${colNames.map(() => '?').join(',')},?)`,
        [ctx.firmId, m.id, ...Object.values(cols), ctx.userId],
      );
    } catch (e) {
      if (isDuplicateKey(e)) throw e;
      throw e;
    }
  } else {
    const colNames = Object.keys(cols);
    await ctx.c.query(
      `UPDATE ${def.table} SET ${colNames.length ? colNames.map((c2) => `${c2} = ?`).join(', ') + ', ' : ''}deleted_at = NULL, rev = rev + 1, updated_by = ?
       WHERE firm_id = ? AND id = ?`,
      [...Object.values(cols), ctx.userId, ctx.firmId, m.id],
    );
  }
  const row = (await ctx.c.query(`SELECT * FROM ${def.table} WHERE firm_id = ? AND id = ?`, [ctx.firmId, m.id]))[0] as any[];
  return applied(m, Number(row[0].rev));
}

async function masterDelete(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  await deleteWithCascade(ctx.c, m.entity as any, ctx.firmId, m.id, ctx.userId);
  return applied(m, (m.rev ?? 0) + 1);
}

// ---------------------------------------------------------------- routes (LWW)

function routePair(m: Mutation): { partyId: string; locationId: string } | null {
  if (m.data?.partyId && m.data?.locationId) return { partyId: m.data.partyId, locationId: m.data.locationId };
  if (typeof m.id === 'string' && m.id.includes('::')) {
    const [partyId, locationId] = m.id.split('::');
    if (isUuid(partyId) && isUuid(locationId)) return { partyId, locationId };
  }
  return null;
}

async function routeUpsert(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  const pair = routePair(m);
  if (!pair) return reject(m, 'BAD_ID', 'route needs partyId+locationId');
  const distanceKm = num(m.data?.distanceKm);
  const revenuePerBag = num(m.data?.revenuePerBag);
  const [rows] = await ctx.c.query(
    'SELECT id, rev, deleted_at FROM party_routes WHERE firm_id = ? AND party_id = ? AND location_id = ? FOR UPDATE',
    [ctx.firmId, pair.partyId, pair.locationId],
  );
  const existing = (rows as any[])[0];
  if (existing) {
    await ctx.c.query(
      'UPDATE party_routes SET distance_km = ?, revenue_per_bag = ?, deleted_at = NULL, rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ?',
      [distanceKm, revenuePerBag, ctx.userId, ctx.firmId, existing.id],
    );
    return applied({ ...m, id: existing.id }, Number(existing.rev) + 1);
  }
  const id = isUuid(m.id) ? m.id : newId();
  await ctx.c.query(
    'INSERT INTO party_routes (firm_id, id, party_id, location_id, distance_km, revenue_per_bag, updated_by) VALUES (?,?,?,?,?,?,?)',
    [ctx.firmId, id, pair.partyId, pair.locationId, distanceKm, revenuePerBag, ctx.userId],
  );
  return applied({ ...m, id }, 1);
}

async function routeDelete(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  const pair = routePair(m);
  if (pair) {
    await ctx.c.query(
      'UPDATE party_routes SET deleted_at = UTC_TIMESTAMP(3), rev = rev + 1, updated_by = ? WHERE firm_id = ? AND party_id = ? AND location_id = ? AND deleted_at IS NULL',
      [ctx.userId, ctx.firmId, pair.partyId, pair.locationId],
    );
  } else if (isUuid(m.id)) {
    await softDeleteRow(ctx.c, 'party_routes', ctx.firmId, m.id, ctx.userId);
  }
  return applied(m, (m.rev ?? 0) + 1);
}

// ---------------------------------------------------------------- freight (§9.4: reject on rev mismatch)

async function freightUpsert(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  if (!isUuid(m.id)) return reject(m, 'BAD_ID', 'id must be a UUID');
  const d = m.data ?? {};
  const [rows] = await ctx.c.query('SELECT * FROM freight_entries WHERE firm_id = ? AND id = ? FOR UPDATE', [ctx.firmId, m.id]);
  const existing = (rows as any[])[0];

  if (!existing) {
    const date = parseBusinessDate(d.date);
    if (!date || !isUuid(d.partyId) || !isUuid(d.locationId)) return reject(m, 'VALIDATION_FAILED', 'freight entry needs date/partyId/locationId');
    const w: FreightInput = {
      revenuePerBag: num(d.revenuePerBag), bags: num(d.bags), totalReimbursed: num(d.totalReimbursed),
      basis: d.basis === 'bag' ? ('bag' as const) : ('km' as const),
      costRate: num(d.costRate), costUnits: num(d.costUnits), otherExpenses: num(d.otherExpenses),
      totalCost: num(d.totalCost), profit: num(d.profit),
      gradeBags: (d.gradeBags ?? {}) as Record<string, number>,
    };
    try {
      validateFreightEntry(w);
    } catch (e: any) {
      return reject(m, e.code ?? 'VALIDATION_FAILED', e.message);
    }
    // §5.1 server-authoritative serial for entries created offline.
    const [u]: any = await ctx.c.query(
      'UPDATE firm_counters SET freight_serial = LAST_INSERT_ID(freight_serial + 1) WHERE firm_id = ?', [ctx.firmId]);
    if (u.affectedRows === 0) {
      await ctx.c.query('INSERT INTO firm_counters (firm_id, freight_serial) VALUES (?, LAST_INSERT_ID(1))', [ctx.firmId]);
    }
    const serial = Number(((await ctx.c.query('SELECT LAST_INSERT_ID() AS s'))[0] as any[])[0].s);
    await ctx.c.query(
      `INSERT INTO freight_entries (firm_id, id, serial, date, party_id, location_id, vehicle_no, revenue_per_bag, bags,
         total_reimbursed, basis, cost_rate, cost_units, other_expenses, other_note, total_cost, profit, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ctx.firmId, m.id, serial, date, d.partyId, d.locationId, String(d.vehicleNo ?? '').toUpperCase(), w.revenuePerBag, w.bags,
       w.totalReimbursed, w.basis, w.costRate, w.costUnits, w.otherExpenses, String(d.otherNote ?? ''), w.totalCost, w.profit, ctx.userId],
    );
    await writeGradeBags(ctx.c, ctx.firmId, m.id, w.gradeBags ?? {});
    return { ...applied(m, 1), serial };
  }

  // Existing row — rev gate for money records.
  if (m.rev === undefined || m.rev !== Number(existing.rev)) {
    return conflict(m, 'REV_MISMATCH', mapFreightEntry(existing, (await gradeBagsForConn(ctx, [m.id]))[m.id] ?? {}));
  }
  if (existing.deleted_at !== null) {
    return conflict(m, 'REV_MISMATCH', mapFreightEntry(existing, {}));
  }
  const date = d.date ? parseBusinessDate(d.date) : existing.date;
  if (!date) return reject(m, 'VALIDATION_FAILED', 'invalid date');
  const merged: any = {
    revenuePerBag: d.revenuePerBag ?? num(existing.revenue_per_bag), bags: d.bags ?? num(existing.bags),
    totalReimbursed: d.totalReimbursed ?? num(existing.total_reimbursed), basis: d.basis ?? existing.basis,
    costRate: d.costRate ?? num(existing.cost_rate), costUnits: d.costUnits ?? num(existing.cost_units),
    otherExpenses: d.otherExpenses ?? num(existing.other_expenses), totalCost: d.totalCost ?? num(existing.total_cost),
    profit: d.profit ?? num(existing.profit),
    gradeBags: d.gradeBags as Record<string, number> | undefined,
  };
  try {
    validateFreightEntry(merged);
  } catch (e: any) {
    return reject(m, e.code ?? 'VALIDATION_FAILED', e.message);
  }
  await ctx.c.query(
    `UPDATE freight_entries SET date=?, party_id=?, location_id=?, vehicle_no=?, revenue_per_bag=?, bags=?, total_reimbursed=?,
       basis=?, cost_rate=?, cost_units=?, other_expenses=?, other_note=?, total_cost=?, profit=?, rev=rev+1, updated_by=?
     WHERE firm_id=? AND id=?`,
    [date, d.partyId ?? existing.party_id, d.locationId ?? existing.location_id,
     String(d.vehicleNo ?? existing.vehicle_no ?? '').toUpperCase(), merged.revenuePerBag, merged.bags,
     merged.totalReimbursed, merged.basis, merged.costRate, merged.costUnits, merged.otherExpenses,
     d.otherNote ?? existing.other_note ?? '', merged.totalCost, merged.profit, ctx.userId, ctx.firmId, m.id],
  );
  if (merged.gradeBags !== undefined) await writeGradeBags(ctx.c, ctx.firmId, m.id, merged.gradeBags);
  return applied(m, Number(existing.rev) + 1);
}

async function gradeBagsForConn(ctx: Ctx, entryIds: string[]): Promise<Record<string, Record<string, number>>> {
  if (!entryIds.length) return {};
  const [rows] = await ctx.c.query(
    `SELECT entry_id, grade_id, bags FROM freight_entry_grades WHERE firm_id = ? AND entry_id IN (${entryIds.map(() => '?').join(',')})`,
    [ctx.firmId, ...entryIds],
  );
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows as any[]) (out[r.entry_id] ??= {})[r.grade_id] = num(r.bags);
  return out;
}

async function writeGradeBags(c: PoolConnection, firmId: string, entryId: string, gb: Record<string, number>): Promise<void> {
  await c.query('DELETE FROM freight_entry_grades WHERE firm_id = ? AND entry_id = ?', [firmId, entryId]);
  for (const [g, b] of Object.entries(gb)) {
    await c.query('INSERT INTO freight_entry_grades (firm_id, entry_id, grade_id, bags) VALUES (?,?,?,?)', [firmId, entryId, g, b]);
  }
}

async function freightDelete(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  const [rows] = await ctx.c.query('SELECT * FROM freight_entries WHERE firm_id = ? AND id = ? FOR UPDATE', [ctx.firmId, m.id]);
  const existing = (rows as any[])[0];
  if (!existing || existing.deleted_at) return applied(m, m.rev ?? 0);
  if (m.rev === undefined || m.rev !== Number(existing.rev)) {
    return conflict(m, 'REV_MISMATCH', mapFreightEntry(existing, (await gradeBagsForConn(ctx, [m.id]))[m.id] ?? {}));
  }
  const serial = Number(existing.serial);
  await softDeleteRow(ctx.c, 'freight_entries', ctx.firmId, m.id, ctx.userId);
  await compactSerialsAfterDelete(ctx.c, ctx.firmId, serial, ctx.userId);
  return applied(m, Number(existing.rev) + 1);
}

// ---------------------------------------------------------------- stock days (§9.4: field-level merge)

function stockDayDate(m: Mutation): string | null {
  if (m.data?.date) return parseBusinessDate(m.data.date);
  const pipe = typeof m.id === 'string' ? m.id.indexOf('|') : -1;
  if (pipe > 0) return parseBusinessDate(m.id.slice(pipe + 1));
  return null;
}

async function stockDayUpsert(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  const date = stockDayDate(m);
  if (!date) return reject(m, 'VALIDATION_FAILED', 'stockDays upsert needs a valid date');
  const baseline = (await ctx.c.query('SELECT date FROM opening_baselines WHERE firm_id = ? AND deleted_at IS NULL FOR UPDATE', [ctx.firmId]))[0] as any[];
  if (!baseline.length || date <= baseline[0].date) return reject(m, 'DAY_BEFORE_BASELINE', 'Stock day must be after the baseline date');

  const [found] = await ctx.c.query('SELECT * FROM stock_days WHERE firm_id = ? AND date = ? FOR UPDATE', [ctx.firmId, date]);
  let day = (found as any[])[0];
  if (!day) {
    const id = newId();
    await ctx.c.query('INSERT INTO stock_days (firm_id, id, date, updated_by) VALUES (?,?,?,?)', [ctx.firmId, id, date, ctx.userId]);
    day = ((await ctx.c.query('SELECT * FROM stock_days WHERE firm_id = ? AND id = ?', [ctx.firmId, id]))[0] as any[])[0];
  } else if (day.deleted_at) {
    await ctx.c.query('UPDATE stock_days SET deleted_at = NULL, rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ?', [ctx.userId, ctx.firmId, day.id]);
  }

  // Receipts: additive by id (removals come through DELETE .../receipts/:id).
  // grade_id is updated too: the client can edit a receipt's grade, and leaving
  // it out silently kept the old grade server-side — the edit looked applied on
  // the device and then reverted on the next pull.
  for (const r of m.data?.receipts ?? []) {
    if (!isUuid(r.id) || !isUuid(r.gradeId)) return reject(m, 'VALIDATION_FAILED', 'receipt needs id + gradeId');
    await ctx.c.query(
      `INSERT INTO stock_receipts (firm_id, id, stock_day_id, grade_id, qty, sap_qty, ref) VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE grade_id = VALUES(grade_id), qty = VALUES(qty), sap_qty = VALUES(sap_qty), ref = VALUES(ref)`,
      [ctx.firmId, r.id, day.id, r.gradeId, num(r.qty), num(r.sapQty), String(r.ref ?? '')],
    );
  }
  // Cells: per-(party,grade) field-level merge; {0,0} deletes (§6.6).
  const rowsMap = (m.data?.rows ?? {}) as Record<string, Record<string, { billing: number; dispatch: number }>>;
  for (const [partyId, grades] of Object.entries(rowsMap)) {
    for (const [gradeId, cell] of Object.entries(grades)) {
      const billing = num(cell?.billing);
      const dispatch = num(cell?.dispatch);
      if (billing === 0 && dispatch === 0) {
        await ctx.c.query('DELETE FROM stock_day_cells WHERE firm_id = ? AND stock_day_id = ? AND party_id = ? AND grade_id = ?', [ctx.firmId, day.id, partyId, gradeId]);
      } else {
        await ctx.c.query(
          `INSERT INTO stock_day_cells (firm_id, stock_day_id, party_id, grade_id, billing, dispatch) VALUES (?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE billing = VALUES(billing), dispatch = VALUES(dispatch)`,
          [ctx.firmId, day.id, partyId, gradeId, billing, dispatch],
        );
      }
    }
  }
  const [revRows] = await ctx.c.query('UPDATE stock_days SET rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ?', [ctx.userId, ctx.firmId, day.id]);
  void revRows;
  const fresh = ((await ctx.c.query('SELECT rev FROM stock_days WHERE firm_id = ? AND id = ?', [ctx.firmId, day.id]))[0] as any[])[0];
  return applied({ ...m, id: day.id }, Number(fresh.rev));
}

async function stockDayDelete(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  let dayId = isUuid(m.id) ? m.id : null;
  if (!dayId) {
    // natural key "firmId|yyyy-MM-dd"
    const date = stockDayDate(m);
    if (date) {
      const [rows] = await ctx.c.query('SELECT id FROM stock_days WHERE firm_id = ? AND date = ?', [ctx.firmId, date]);
      dayId = (rows as any[])[0]?.id ?? null;
    }
  }
  if (dayId) await softDeleteRow(ctx.c, 'stock_days', ctx.firmId, dayId, ctx.userId);
  return applied(m, (m.rev ?? 0) + 1);
}

// ---------------------------------------------------------------- baseline (§9.4: reject on mismatch)

async function baselineUpsert(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  const d = m.data ?? {};
  const date = parseBusinessDate(d.date);
  if (!date) return reject(m, 'VALIDATION_FAILED', 'baseline needs a valid date');
  const [found] = await ctx.c.query('SELECT * FROM opening_baselines WHERE firm_id = ? FOR UPDATE', [ctx.firmId]);
  const existing = (found as any[])[0];
  if (existing && m.rev !== undefined && m.rev !== Number(existing.rev)) {
    const inv = await ctx.c.query('SELECT COUNT(*) AS n FROM stock_days WHERE firm_id = ? AND deleted_at IS NULL AND date <= ?', [ctx.firmId, date]);
    void inv;
    return conflict(m, 'REV_MISMATCH', { firmId: ctx.firmId, date: existing.date, rev: Number(existing.rev), deletedAt: existing.deleted_at });
  }
  const badDays = (await ctx.c.query('SELECT COUNT(*) AS n FROM stock_days WHERE firm_id = ? AND deleted_at IS NULL AND date <= ?', [ctx.firmId, date]))[0] as any[];
  if (Number(badDays[0].n) > 0) return reject(m, 'BUSINESS_RULE_VIOLATION', 'Baseline date would invalidate existing stock days');

  if (existing) {
    await ctx.c.query('UPDATE opening_baselines SET date = ?, deleted_at = NULL, rev = rev + 1, updated_by = ? WHERE firm_id = ?', [date, ctx.userId, ctx.firmId]);
  } else {
    await ctx.c.query('INSERT INTO opening_baselines (firm_id, date, updated_by) VALUES (?,?,?)', [ctx.firmId, date, ctx.userId]);
  }
  await ctx.c.query('DELETE FROM opening_baseline_stock WHERE firm_id = ?', [ctx.firmId]);
  await ctx.c.query('DELETE FROM opening_baseline_party WHERE firm_id = ?', [ctx.firmId]);
  const physical = d.physical ?? {}; const sap = d.sap ?? {};
  for (const g of new Set([...Object.keys(physical), ...Object.keys(sap)])) {
    await ctx.c.query('INSERT INTO opening_baseline_stock (firm_id, grade_id, physical, sap) VALUES (?,?,?,?)', [ctx.firmId, g, num(physical[g]), num(sap[g])]);
  }
  for (const [partyId, grades] of Object.entries(d.party ?? {})) {
    for (const [gradeId, xQty] of Object.entries(grades as Record<string, number>)) {
      await ctx.c.query('INSERT INTO opening_baseline_party (firm_id, party_id, grade_id, x_qty) VALUES (?,?,?,?)', [ctx.firmId, partyId, gradeId, num(xQty)]);
    }
  }
  const rev = Number(((await ctx.c.query('SELECT rev FROM opening_baselines WHERE firm_id = ?', [ctx.firmId]))[0] as any[])[0].rev);
  return applied(m, rev);
}

// ---------------------------------------------------------------- purchases (§9.4: reject on mismatch)

async function purchaseUpsert(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  if (!isUuid(m.id)) return reject(m, 'BAD_ID', 'id must be a UUID');
  const d = m.data ?? {};
  const [rows] = await ctx.c.query('SELECT * FROM purchases WHERE firm_id = ? AND id = ? FOR UPDATE', [ctx.firmId, m.id]);
  const existing = (rows as any[])[0];
  const date = d.date ? parseBusinessDate(d.date) : existing?.date;
  if (!date) return reject(m, 'VALIDATION_FAILED', 'invalid date');
  const merged = {
    companyId: d.companyId ?? existing?.company_id, gradeId: d.gradeId ?? existing?.grade_id, sourceId: d.sourceId ?? existing?.source_id,
    qty: d.qty ?? num(existing?.qty), ratePerBag: d.ratePerBag ?? num(existing?.rate_per_bag), invoiceNo: d.invoiceNo ?? existing?.invoice_no ?? '',
  };
  if (!isUuid(merged.companyId) || !isUuid(merged.gradeId) || !isUuid(merged.sourceId)) {
    return reject(m, 'VALIDATION_FAILED', 'purchase needs companyId/gradeId/sourceId');
  }
  try {
    validatePurchase({ qty: num(merged.qty), ratePerBag: num(merged.ratePerBag) });
  } catch (e: any) {
    return reject(m, e.code ?? 'VALIDATION_FAILED', e.message);
  }

  if (!existing) {
    await ctx.c.query(
      `INSERT INTO purchases (firm_id, id, date, company_id, grade_id, source_id, qty, rate_per_bag, invoice_no, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [ctx.firmId, m.id, date, merged.companyId, merged.gradeId, merged.sourceId, num(merged.qty), num(merged.ratePerBag), merged.invoiceNo, ctx.userId],
    );
  } else {
    if (m.rev === undefined || m.rev !== Number(existing.rev)) {
      return conflict(m, 'REV_MISMATCH', mapPurchase(existing, await paymentsForConn(ctx, [m.id])));
    }
    if (existing.deleted_at) return conflict(m, 'REV_MISMATCH', mapPurchase(existing, []));
    await ctx.c.query(
      `UPDATE purchases SET date=?, company_id=?, grade_id=?, source_id=?, qty=?, rate_per_bag=?, invoice_no=?, rev=rev+1, updated_by=?
       WHERE firm_id=? AND id=?`,
      [date, merged.companyId, merged.gradeId, merged.sourceId, num(merged.qty), num(merged.ratePerBag), merged.invoiceNo, ctx.userId, ctx.firmId, m.id],
    );
  }
  for (const p of d.payments ?? []) {
    if (!isUuid(p.id)) continue;
    await upsertPaymentRow(ctx, m.id, p.id, parseBusinessDate(p.date), num(p.amount));
  }
  const rev = Number(((await ctx.c.query('SELECT rev FROM purchases WHERE firm_id = ? AND id = ?', [ctx.firmId, m.id]))[0] as any[])[0].rev);
  return applied(m, rev);
}

async function paymentsForConn(ctx: Ctx, ids: string[]): Promise<any[]> {
  if (!ids.length) return [];
  const [rows] = await ctx.c.query(
    `SELECT * FROM purchase_payments WHERE firm_id = ? AND purchase_id IN (${ids.map(() => '?').join(',')})`, [ctx.firmId, ...ids]);
  return rows as any[];
}

async function upsertPaymentRow(ctx: Ctx, purchaseId: string, id: string, date: string | null, amount: number): Promise<void> {
  if (!date) throw errors.validation('payment needs a valid date');
  await ctx.c.query(
    `INSERT INTO purchase_payments (firm_id, id, purchase_id, date, amount) VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE date = VALUES(date), amount = VALUES(amount)`,
    [ctx.firmId, id, purchaseId, date, amount],
  );
}

async function paymentUpsert(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  const purchaseId = m.data?.purchaseId;
  if (!isUuid(m.id) || !isUuid(purchaseId)) return reject(m, 'BAD_ID', 'payment upsert needs id + purchaseId');
  const [rows] = await ctx.c.query('SELECT id, deleted_at FROM purchases WHERE firm_id = ? AND id = ? FOR UPDATE', [ctx.firmId, purchaseId]);
  const existing = (rows as any[])[0];
  if (!existing || existing.deleted_at) return reject(m, 'NOT_FOUND', 'Purchase not found');
  await upsertPaymentRow(ctx, purchaseId, m.id, parseBusinessDate(m.data?.date), num(m.data?.amount));
  await ctx.c.query('UPDATE purchases SET rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ?', [ctx.userId, ctx.firmId, purchaseId]);
  return applied(m, (m.rev ?? 0) + 1);
}

async function paymentDelete(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  const purchaseId = m.data?.purchaseId;
  if (!purchaseId || !isUuid(m.id)) return reject(m, 'BAD_ID', 'payment delete needs id + purchaseId');
  await ctx.c.query('DELETE FROM purchase_payments WHERE firm_id = ? AND id = ?', [ctx.firmId, m.id]);
  await ctx.c.query('UPDATE purchases SET rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ? AND deleted_at IS NULL', [ctx.userId, ctx.firmId, purchaseId]);
  return applied(m, (m.rev ?? 0) + 1);
}

async function purchaseDelete(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  const [rows] = await ctx.c.query('SELECT * FROM purchases WHERE firm_id = ? AND id = ? FOR UPDATE', [ctx.firmId, m.id]);
  const existing = (rows as any[])[0];
  if (!existing || existing.deleted_at) return applied(m, m.rev ?? 0);
  if (m.rev === undefined || m.rev !== Number(existing.rev)) {
    return conflict(m, 'REV_MISMATCH', mapPurchase(existing, await paymentsForConn(ctx, [m.id])));
  }
  await softDeleteRow(ctx.c, 'purchases', ctx.firmId, m.id, ctx.userId);
  return applied(m, Number(existing.rev) + 1);
}

// ---------------------------------------------------------------- schemes (LWW; client freezes claims itself)

async function schemeUpsert(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  if (!isUuid(m.id)) return reject(m, 'BAD_ID', 'id must be a UUID');
  const d = m.data ?? {};
  const input = {
    kind: (['fixed', 'variable', 'mix', 'cash'] as const).includes(d.kind) ? d.kind : 'fixed',
    period: d.period ?? null,
    windowFrom: d.windowFrom ? parseBusinessDate(d.windowFrom) : null,
    windowTo: d.windowTo ? parseBusinessDate(d.windowTo) : null,
    qtyUnit: d.qtyUnit === 'mt' ? 'mt' : 'bag',
    valueType: (['perBag', 'perMt', 'percent'] as const).includes(d.valueType) ? d.valueType : 'perBag',
    premiumGradeIds: (d.premiumGradeIds ?? []) as string[],
    minPremiumQty: num(d.minPremiumQty),
    slabs: (d.slabs ?? []) as { from: number; value: number }[],
    active: d.active !== false,
  } as const;
  try {
    validateScheme(input);
  } catch (e: any) {
    return reject(m, e.code ?? 'VALIDATION_FAILED', e.message);
  }
  if (!isUuid(d.companyId)) return reject(m, 'VALIDATION_FAILED', 'scheme needs companyId');
  const [rows] = await ctx.c.query('SELECT * FROM schemes WHERE firm_id = ? AND id = ? FOR UPDATE', [ctx.firmId, m.id]);
  const existing = (rows as any[])[0];
  if (!existing) {
    if (!d.name) return reject(m, 'VALIDATION_FAILED', 'scheme needs name');
    await ctx.c.query(
      `INSERT INTO schemes (firm_id, id, name, company_id, grade_id, per_grade, source_id, kind, period, window_from, window_to,
         qty_unit, value_type, min_premium_qty, min_premium_unit, active, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ctx.firmId, m.id, String(d.name), d.companyId, d.gradeId ?? null, d.perGrade ? 1 : 0, d.sourceId ?? null,
       input.kind, input.period, input.windowFrom, input.windowTo, input.qtyUnit, input.valueType, input.minPremiumQty,
       d.minPremiumUnit === 'bag' ? 'bag' : 'mt', input.active ? 1 : 0, ctx.userId],
    );
  } else {
    await ctx.c.query(
      `UPDATE schemes SET name=?, company_id=?, grade_id=?, per_grade=?, source_id=?, kind=?, period=?, window_from=?, window_to=?,
         qty_unit=?, value_type=?, min_premium_qty=?, min_premium_unit=?, active=?, deleted_at=NULL, rev=rev+1, updated_by=?
       WHERE firm_id=? AND id=?`,
      [d.name ?? existing.name, d.companyId, d.gradeId ?? null, d.perGrade ? 1 : 0, d.sourceId ?? null, input.kind, input.period, input.windowFrom,
       input.windowTo, input.qtyUnit, input.valueType, input.minPremiumQty, d.minPremiumUnit === 'bag' ? 'bag' : 'mt',
       input.active ? 1 : 0, ctx.userId, ctx.firmId, m.id],
    );
  }
  if (d.slabs !== undefined || d.premiumGradeIds !== undefined || !existing) {
    await ctx.c.query('DELETE FROM scheme_slabs WHERE firm_id = ? AND scheme_id = ?', [ctx.firmId, m.id]);
    await ctx.c.query('DELETE FROM scheme_premium_grades WHERE firm_id = ? AND scheme_id = ?', [ctx.firmId, m.id]);
    for (const s of sortSlabs(input.slabs)) {
      await ctx.c.query('INSERT INTO scheme_slabs (firm_id, scheme_id, slab_from, slab_value) VALUES (?,?,?,?)', [ctx.firmId, m.id, s.from, s.value]);
    }
    for (const g of Array.from(new Set(input.premiumGradeIds))) {
      await ctx.c.query('INSERT INTO scheme_premium_grades (firm_id, scheme_id, grade_id) VALUES (?,?,?)', [ctx.firmId, m.id, g]);
    }
  }
  const rev = Number(((await ctx.c.query('SELECT rev FROM schemes WHERE firm_id = ? AND id = ?', [ctx.firmId, m.id]))[0] as any[])[0].rev);
  return applied(m, rev);
}

async function schemeDelete(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  const ok = await softDeleteRow(ctx.c, 'schemes', ctx.firmId, m.id, ctx.userId);
  if (ok) {
    // claims of the scheme go too (§5.6) — explicit, not via FK (§6.7 note).
    await ctx.c.query(
      'UPDATE claims SET deleted_at = UTC_TIMESTAMP(3), rev = rev + 1, updated_by = ? WHERE firm_id = ? AND scheme_id = ? AND deleted_at IS NULL',
      [ctx.userId, ctx.firmId, m.id],
    );
  }
  return applied(m, (m.rev ?? 0) + 1);
}

// ---------------------------------------------------------------- claims (§9.4: reject on mismatch + immutable)

async function claimUpsert(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  if (!isUuid(m.id)) return reject(m, 'BAD_ID', 'id must be a UUID');
  const d = m.data ?? {};
  const periodFrom = parseBusinessDate(d.periodFrom);
  const periodTo = parseBusinessDate(d.periodTo);
  if (!periodFrom || !periodTo) return reject(m, 'VALIDATION_FAILED', 'claim needs periodFrom/periodTo');
  try {
    validateClaim({ accrued: num(d.accrued), periodFrom, periodTo });
  } catch (e: any) {
    return reject(m, e.code ?? 'VALIDATION_FAILED', e.message);
  }
  const [rows] = await ctx.c.query('SELECT * FROM claims WHERE firm_id = ? AND id = ? FOR UPDATE', [ctx.firmId, m.id]);
  const existing = (rows as any[])[0];
  if (!existing) {
    if (!isUuid(d.schemeId) || !isUuid(d.companyId)) return reject(m, 'VALIDATION_FAILED', 'claim needs schemeId/companyId');
    try {
      await ctx.c.query(
        `INSERT INTO claims (firm_id, id, scheme_id, company_id, scheme_name, period_from, period_to, label, bags, accrued, updated_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [ctx.firmId, m.id, d.schemeId, d.companyId, d.schemeName ?? '', periodFrom, periodTo, d.label ?? '', num(d.bags), num(d.accrued), ctx.userId],
      );
    } catch (e) {
      if (isDuplicateKey(e)) return reject(m, 'DUPLICATE_KEY', 'Claim exists for this scheme and period');
      throw e;
    }
    return applied(m, 1);
  }
  if (m.rev === undefined || m.rev !== Number(existing.rev)) {
    return conflict(m, 'REV_MISMATCH', mapClaim(existing, await notesForConn(ctx, [m.id])));
  }
  // Immutable-field gate (§5.4).
  const diffs: [string, unknown, unknown][] = [
    ['bags', num(existing.bags), num(d.bags ?? existing.bags)],
    ['accrued', num(existing.accrued), num(d.accrued ?? existing.accrued)],
    ['periodFrom', existing.period_from, d.periodFrom ? periodFrom : existing.period_from],
    ['periodTo', existing.period_to, d.periodTo ? periodTo : existing.period_to],
    ['label', existing.label ?? '', d.label ?? existing.label ?? ''],
    ['schemeId', existing.scheme_id, d.schemeId ?? existing.scheme_id],
  ];
  for (const [f, cur, next] of diffs) {
    const changed = typeof next === 'number' ? Math.abs(next - (cur as number)) > 0.01 : String(next) !== String(cur);
    if (changed) return reject(m, 'CLAIM_IMMUTABLE', `Claim field '${f}' is frozen`);
  }
  const status = ['claimable', 'claimed', 'received'].includes(d.status) ? d.status : existing.status;
  const sentOn = d.sentOn !== undefined ? parseBusinessDate(d.sentOn) : existing.sent_on;
  await ctx.c.query('UPDATE claims SET status = ?, sent_on = ?, scheme_name = ?, rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ?', [
    status, sentOn, d.schemeName ?? existing.scheme_name ?? '', ctx.userId, ctx.firmId, m.id,
  ]);
  for (const note of d.creditNotes ?? []) {
    if (!isUuid(note.id)) continue;
    await upsertNoteRow(ctx, m.id, note.id, parseBusinessDate(note.date), String(note.number ?? ''), num(note.amount));
  }
  await applyAutoStatus(ctx, m.id);
  const rev = Number(((await ctx.c.query('SELECT rev FROM claims WHERE firm_id = ? AND id = ?', [ctx.firmId, m.id]))[0] as any[])[0].rev);
  return applied(m, rev);
}

async function notesForConn(ctx: Ctx, ids: string[]): Promise<any[]> {
  if (!ids.length) return [];
  const [rows] = await ctx.c.query(
    `SELECT * FROM claim_credit_notes WHERE firm_id = ? AND claim_id IN (${ids.map(() => '?').join(',')})`, [ctx.firmId, ...ids]);
  return rows as any[];
}

async function upsertNoteRow(ctx: Ctx, claimId: string, id: string, date: string | null, number: string, amount: number): Promise<void> {
  if (!date) throw errors.validation('credit note needs a valid date');
  await ctx.c.query(
    `INSERT INTO claim_credit_notes (firm_id, id, claim_id, date, number, amount) VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE date = VALUES(date), number = VALUES(number), amount = VALUES(amount)`,
    [ctx.firmId, id, claimId, date, number, amount],
  );
}

async function applyAutoStatus(ctx: Ctx, claimId: string): Promise<void> {
  const [claims] = await ctx.c.query('SELECT status, accrued, sent_on FROM claims WHERE firm_id = ? AND id = ?', [ctx.firmId, claimId]);
  const r = (claims as any[])[0];
  if (!r) return;
  const [notes] = await ctx.c.query('SELECT amount FROM claim_credit_notes WHERE firm_id = ? AND claim_id = ?', [ctx.firmId, claimId]);
  const list = notes as any[];
  const status = claimAutoStatus({
    status: r.status, accrued: num(r.accrued),
    receivedAmount: list.reduce((a, x) => a + num(x.amount), 0), hasCreditNotes: list.length > 0, sentOn: r.sent_on ?? null,
  });
  await ctx.c.query('UPDATE claims SET status = ? WHERE firm_id = ? AND id = ?', [status, ctx.firmId, claimId]);
}

async function creditNoteUpsert(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  const claimId = m.data?.claimId;
  if (!isUuid(m.id) || !isUuid(claimId)) return reject(m, 'BAD_ID', 'credit note upsert needs id + claimId');
  const [rows] = await ctx.c.query('SELECT deleted_at FROM claims WHERE firm_id = ? AND id = ? FOR UPDATE', [ctx.firmId, claimId]);
  const existing = (rows as any[])[0];
  if (!existing || existing.deleted_at) return reject(m, 'NOT_FOUND', 'Claim not found');
  await upsertNoteRow(ctx, claimId, m.id, parseBusinessDate(m.data?.date), String(m.data?.number ?? ''), num(m.data?.amount));
  await ctx.c.query('UPDATE claims SET rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ?', [ctx.userId, ctx.firmId, claimId]);
  await applyAutoStatus(ctx, claimId);
  return applied(m, (m.rev ?? 0) + 1);
}

async function creditNoteDelete(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  const claimId = m.data?.claimId;
  if (!claimId || !isUuid(m.id)) return reject(m, 'BAD_ID', 'credit note delete needs id + claimId');
  await ctx.c.query('DELETE FROM claim_credit_notes WHERE firm_id = ? AND id = ?', [ctx.firmId, m.id]);
  await ctx.c.query('UPDATE claims SET rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ? AND deleted_at IS NULL', [ctx.userId, ctx.firmId, claimId]);
  await applyAutoStatus(ctx, claimId);
  return applied(m, (m.rev ?? 0) + 1);
}

async function claimDelete(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  const [rows] = await ctx.c.query('SELECT * FROM claims WHERE firm_id = ? AND id = ? FOR UPDATE', [ctx.firmId, m.id]);
  const existing = (rows as any[])[0];
  if (!existing || existing.deleted_at) return applied(m, m.rev ?? 0);
  if (m.rev === undefined || m.rev !== Number(existing.rev)) {
    return conflict(m, 'REV_MISMATCH', mapClaim(existing, await notesForConn(ctx, [m.id])));
  }
  await softDeleteRow(ctx.c, 'claims', ctx.firmId, m.id, ctx.userId);
  return applied(m, Number(existing.rev) + 1);
}


