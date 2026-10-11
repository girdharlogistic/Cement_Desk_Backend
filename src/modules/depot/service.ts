/**
 * Depot diary — trucks in, bags out, stock adjustments and the labour rates
 * that pay for the lifting. See migrations-sqlite/0004_depot_diary.sql for
 * what each table means.
 *
 * Sync-only. The app writes through `POST /sync/push` like every other record
 * and nothing else needs these rows, so there are no REST routes beyond what
 * the labour master gets for free from MASTER_DEFS.
 *
 * The server stores and validates; it computes nothing. Godown stock, the
 * truck tally and the labour bill are the app's arithmetic, the same split as
 * freight margins and scheme accruals. What *is* checked here is shape: real
 * ids, real dates, finite non-negative bag counts, and that a dispatch has
 * bags at all.
 */
import { Q } from '../../db/pool';
import { parseBusinessDate } from '../../lib/dates';
import { isUuid } from '../../lib/ids';
import { num } from '../../lib/num';
import { softDeleteRow } from '../masters/service';
import { syncMeta } from '../../plugins/guards';
import type { Mutation, PushOutcome } from '../sync/push';

/** Far beyond any real truck or godown, and still exact in a double. */
const MAX_BAGS = 10_000_000;
const MAX_RATE = 100_000;

type GradeBags = Record<string, number>;

export class DepotInvalid extends Error {}

function bad(message: string): never {
  throw new DepotInvalid(message);
}

/**
 * `{gradeId: bags}` from the wire, checked. Zero lines are dropped rather than
 * stored — "0 bags of OPC" says nothing a missing key does not, and keeping
 * them would make two equal maps compare unequal.
 */
export function readGradeBags(v: unknown, field: string, { signed = false } = {}): GradeBags {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) bad(`${field} must be an object of gradeId → bags`);
  const out: GradeBags = {};
  for (const [gradeId, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!isUuid(gradeId)) bad(`${field}: '${gradeId}' is not a grade id`);
    if (typeof raw !== 'number' || !Number.isFinite(raw)) bad(`${field}: bags must be a number`);
    if (!signed && raw < 0) bad(`${field}: bags cannot be negative`);
    if (Math.abs(raw) > MAX_BAGS) bad(`${field}: ${raw} bags is out of range`);
    if (Math.abs(raw) > 1e-9) out[gradeId] = raw;
  }
  return out;
}

function total(g: GradeBags): number {
  return Object.values(g).reduce((a, b) => a + b, 0);
}

function readRate(v: unknown, field: string): number {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_RATE) bad(`${field} must be a rate between 0 and ${MAX_RATE}`);
  return v;
}

function readText(v: unknown, max: number): string {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}

function readOptionalId(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (!isUuid(v)) bad(`${field} must be a UUID`);
  return v;
}

function readDate(v: unknown): string {
  const d = parseBusinessDate(v);
  if (!d) bad('date must be yyyy-MM-dd');
  return d;
}

function parseJson(v: unknown): GradeBags {
  if (typeof v !== 'string' || !v) return {};
  try {
    const o = JSON.parse(v);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- wire maps

export function mapDepotSettings(r: any): any {
  return {
    firmId: r.firm_id,
    unloadRate: num(r.unload_rate),
    directRate: num(r.direct_rate),
    loadRate: num(r.load_rate),
    ...syncMeta(r),
  };
}

export function mapDepotTruck(r: any): any {
  return {
    id: r.id,
    firmId: r.firm_id,
    date: r.date,
    companyId: r.company_id,
    truckNo: r.truck_no ?? '',
    ref: r.ref ?? '',
    received: parseJson(r.received_bags),
    godown: parseJson(r.godown_bags),
    short: parseJson(r.short_bags),
    labourId: r.labour_id ?? null,
    unloadRate: num(r.unload_rate),
    note: r.note ?? '',
    ...syncMeta(r),
  };
}

export function mapDepotDispatch(r: any): any {
  return {
    id: r.id,
    firmId: r.firm_id,
    date: r.date,
    companyId: r.company_id,
    source: r.source,
    truckId: r.truck_id ?? null,
    partyId: r.party_id,
    address: r.address ?? '',
    vehicleNo: r.vehicle_no ?? '',
    gradeBags: parseJson(r.grade_bags),
    labourId: r.labour_id ?? null,
    labourRate: num(r.labour_rate),
    note: r.note ?? '',
    freightEntryId: r.freight_entry_id ?? null,
    ...syncMeta(r),
  };
}

export function mapDepotAdjustment(r: any): any {
  return {
    id: r.id,
    firmId: r.firm_id,
    date: r.date,
    companyId: r.company_id,
    kind: r.kind,
    gradeBags: parseJson(r.grade_bags),
    note: r.note ?? '',
    ...syncMeta(r),
  };
}

export function mapMaterialItem(r: any): any {
  let sizes: unknown = [];
  try {
    sizes = JSON.parse(String(r.sizes ?? '[]'));
  } catch {
    sizes = [];
  }
  return {
    id: r.id,
    firmId: r.firm_id,
    kind: r.kind,
    name: r.name,
    unit: r.unit,
    category: r.category,
    sizes: Array.isArray(sizes) ? sizes : [],
    loadRate: num(r.load_rate),
    unloadRate: num(r.unload_rate),
    order: Number(r.sort_order),
    ...syncMeta(r),
  };
}

export function mapMaterialMove(r: any): any {
  let lines: unknown = [];
  try {
    lines = JSON.parse(String(r.lines ?? '[]'));
  } catch {
    lines = [];
  }
  return {
    id: r.id,
    firmId: r.firm_id,
    date: r.date,
    kind: r.kind,
    partyId: r.party_id ?? null,
    supplier: r.supplier ?? '',
    address: r.address ?? '',
    vehicleNo: r.vehicle_no ?? '',
    labourId: r.labour_id ?? null,
    lines: Array.isArray(lines) ? lines : [],
    note: r.note ?? '',
    ...syncMeta(r),
  };
}

// ---------------------------------------------------------------- push

interface Ctx {
  c: Q;
  firmId: string;
  userId: string;
}

const applied = (m: Mutation, rev: number): PushOutcome => ({ status: 'applied', entity: m.entity, id: m.id, rev });
const reject = (m: Mutation, code: string, message: string): PushOutcome => ({ status: 'rejected', entity: m.entity, id: m.id, code, message });
const conflict = (m: Mutation, server: any): PushOutcome => ({ status: 'conflict', entity: m.entity, id: m.id, reason: 'REV_MISMATCH', server });

export async function applyDepot(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  try {
    switch (m.entity) {
      case 'depotSettings':
        return m.op === 'upsert' ? await settingsUpsert(ctx, m) : reject(m, 'NOT_SUPPORTED', 'Depot settings cannot be deleted');
      case 'depotTrucks':
        return m.op === 'upsert' ? await recordUpsert(ctx, m, TRUCKS) : await recordDelete(ctx, m, TRUCKS);
      case 'depotDispatches':
        return m.op === 'upsert' ? await recordUpsert(ctx, m, DISPATCHES) : await recordDelete(ctx, m, DISPATCHES);
      case 'depotAdjustments':
        return m.op === 'upsert' ? await recordUpsert(ctx, m, ADJUSTMENTS) : await recordDelete(ctx, m, ADJUSTMENTS);
      case 'materialItems':
        return m.op === 'upsert' ? await itemUpsert(ctx, m) : await itemDelete(ctx, m);
      case 'materialMoves':
        return m.op === 'upsert' ? await recordUpsert(ctx, m, MOVES) : await recordDelete(ctx, m, MOVES);
      default:
        return reject(m, 'UNKNOWN_ENTITY', `Unknown entity '${m.entity}'`);
    }
  } catch (e) {
    if (e instanceof DepotInvalid) return reject(m, 'VALIDATION_FAILED', e.message);
    throw e;
  }
}

/**
 * Last write wins, like the masters: three rates nobody edits from two phones
 * at once, and refusing a rate change because another device saved a moment
 * earlier would only make the dealer type it twice.
 */
async function settingsUpsert(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  const d = m.data ?? {};
  const unload = readRate(d.unloadRate, 'unloadRate');
  const direct = readRate(d.directRate, 'directRate');
  const load = readRate(d.loadRate, 'loadRate');
  await ctx.c.query(
    `INSERT INTO depot_settings (firm_id, unload_rate, direct_rate, load_rate, updated_by) VALUES (?,?,?,?,?)
     ON CONFLICT (firm_id) DO UPDATE SET
       unload_rate = excluded.unload_rate, direct_rate = excluded.direct_rate, load_rate = excluded.load_rate,
       deleted_at = NULL, rev = rev + 1, updated_by = excluded.updated_by`,
    [ctx.firmId, unload, direct, load, ctx.userId],
  );
  const [rows] = await ctx.c.query('SELECT rev FROM depot_settings WHERE firm_id = ?', [ctx.firmId]);
  return applied(m, Number((rows as any[])[0].rev));
}

/**
 * Everything that differs between the three diary tables. The rev gate, the
 * tombstone handling and the SQL are shared below, because the three must
 * behave identically under conflict and a fix to one should never have to be
 * remembered for the other two.
 */
interface RecordDef {
  table: 'depot_trucks' | 'depot_dispatches' | 'depot_adjustments' | 'material_moves';
  /** Validated wire data → column values, in a fixed column order. */
  columns(d: any): Record<string, unknown>;
  map(row: any): any;
  /** Runs inside the delete's transaction, after the row is tombstoned. */
  afterDelete?(ctx: Ctx, id: string): Promise<void>;
}

const TRUCKS: RecordDef = {
  table: 'depot_trucks',
  columns(d) {
    const received = readGradeBags(d.received, 'received');
    if (total(received) <= 0) bad('A truck needs the bags it brought');
    if (!isUuid(d.companyId)) bad('companyId must be a UUID');
    return {
      date: readDate(d.date),
      company_id: d.companyId,
      truck_no: readText(d.truckNo, 40).toUpperCase(),
      ref: readText(d.ref, 80),
      received_bags: JSON.stringify(received),
      godown_bags: JSON.stringify(readGradeBags(d.godown, 'godown')),
      short_bags: JSON.stringify(readGradeBags(d.short, 'short')),
      labour_id: readOptionalId(d.labourId, 'labourId'),
      unload_rate: readRate(d.unloadRate, 'unloadRate'),
      note: readText(d.note, 500),
    };
  },
  map: mapDepotTruck,
  // A truck's direct deliveries are part of it — the app sends their deletes
  // too, but a client that forgot must not leave a delivery pointing at a
  // truck that no longer exists, still counted in the register.
  async afterDelete(ctx, id) {
    await ctx.c.query(
      `UPDATE depot_dispatches SET deleted_at = UTC_TIMESTAMP(3), rev = rev + 1, updated_by = ?
        WHERE firm_id = ? AND truck_id = ? AND deleted_at IS NULL`,
      [ctx.userId, ctx.firmId, id],
    );
  },
};

const DISPATCHES: RecordDef = {
  table: 'depot_dispatches',
  columns(d) {
    const gradeBags = readGradeBags(d.gradeBags, 'gradeBags');
    if (total(gradeBags) <= 0) bad('A dispatch needs at least one bag');
    if (!isUuid(d.companyId)) bad('companyId must be a UUID');
    if (!isUuid(d.partyId)) bad('partyId must be a UUID');
    const source = d.source === 'truck' ? 'truck' : d.source === 'godown' || d.source === undefined ? 'godown' : bad("source must be 'godown' or 'truck'");
    const truckId = readOptionalId(d.truckId, 'truckId');
    if (source === 'truck' && !truckId) bad('A direct delivery needs the truck it came off');
    return {
      date: readDate(d.date),
      company_id: d.companyId,
      source,
      truck_id: source === 'truck' ? truckId : null,
      party_id: d.partyId,
      address: readText(d.address, 300),
      vehicle_no: readText(d.vehicleNo, 40).toUpperCase(),
      grade_bags: JSON.stringify(gradeBags),
      labour_id: readOptionalId(d.labourId, 'labourId'),
      labour_rate: readRate(d.labourRate, 'labourRate'),
      note: readText(d.note, 500),
      // Only when sent. An app from before the link existed edits a dispatch
      // without the key, and that edit must not unlink a voucher a newer
      // phone attached.
      ...('freightEntryId' in d ? { freight_entry_id: readOptionalId(d.freightEntryId, 'freightEntryId') } : {}),
    };
  },
  map: mapDepotDispatch,
};

const ADJUSTMENTS: RecordDef = {
  table: 'depot_adjustments',
  columns(d) {
    const kind = (['opening', 'damage', 'correction'] as const).includes(d.kind) ? d.kind : bad("kind must be 'opening', 'damage' or 'correction'");
    // A correction goes either way; an opening only adds and a burst bag only
    // takes away, so those two are held to their sign.
    const gradeBags = readGradeBags(d.gradeBags, 'gradeBags', { signed: kind === 'correction' || kind === 'damage' });
    if (kind === 'damage' && Object.values(gradeBags).some((v) => v > 0)) bad('Damaged bags are recorded as a negative number');
    if (!isUuid(d.companyId)) bad('companyId must be a UUID');
    return {
      date: readDate(d.date),
      company_id: d.companyId,
      kind,
      grade_bags: JSON.stringify(gradeBags),
      note: readText(d.note, 500),
    };
  },
  map: mapDepotAdjustment,
};

const MATERIAL_UNITS = 12;

/**
 * Steel and material moves. Every line names an item and, for steel, a bar
 * size; `qty` is in the item's unit; `bundles` and `rate` are what the app
 * counted and paid at save time and are stored as sent, never recomputed —
 * a brand's bundle size changing next month must not move last month's bill.
 */
const MOVES: RecordDef = {
  table: 'material_moves',
  columns(d) {
    const kind = (['receive', 'dispatch', 'opening', 'adjust'] as const).includes(d.kind) ? d.kind : bad("kind must be 'receive', 'dispatch', 'opening' or 'adjust'");
    if (!Array.isArray(d.lines) || d.lines.length === 0) bad('A move needs at least one line');
    if (d.lines.length > 500) bad('Too many lines on one move');
    const lines = (d.lines as any[]).map((l, i) => {
      if (!l || typeof l !== 'object') bad(`lines[${i}] must be an object`);
      if (!isUuid(l.itemId)) bad(`lines[${i}].itemId must be a UUID`);
      const sizeMm = l.sizeMm === undefined || l.sizeMm === null ? 0 : l.sizeMm;
      if (!Number.isInteger(sizeMm) || sizeMm < 0 || sizeMm > 100) bad(`lines[${i}].sizeMm must be a whole number of mm`);
      const qty = l.qty;
      if (typeof qty !== 'number' || !Number.isFinite(qty) || Math.abs(qty) > MAX_BAGS) bad(`lines[${i}].qty must be a number`);
      if (kind !== 'adjust' && qty < 0) bad(`lines[${i}].qty cannot be negative`);
      const bundles = l.bundles === undefined || l.bundles === null ? 0 : l.bundles;
      if (typeof bundles !== 'number' || !Number.isFinite(bundles) || bundles < 0 || bundles > MAX_BAGS) bad(`lines[${i}].bundles must be a non-negative number`);
      return { itemId: l.itemId, sizeMm, qty, bundles, rate: readRate(l.rate, `lines[${i}].rate`) };
    });
    if (lines.every((l) => Math.abs(l.qty) < 1e-9)) bad('A move needs a quantity on at least one line');
    const partyId = readOptionalId(d.partyId, 'partyId');
    if (kind === 'dispatch' && !partyId) bad('A dispatch needs the customer');
    return {
      date: readDate(d.date),
      kind,
      party_id: partyId,
      supplier: readText(d.supplier, 160),
      address: readText(d.address, 300),
      vehicle_no: readText(d.vehicleNo, 40).toUpperCase(),
      labour_id: readOptionalId(d.labourId, 'labourId'),
      lines: JSON.stringify(lines.filter((l) => Math.abs(l.qty) >= 1e-9)),
      note: readText(d.note, 500),
    };
  },
  map: mapMaterialMove,
};

/**
 * Items are masters: last write wins. The size specs are checked for shape
 * because the app does arithmetic with them — a zero rods-per-bundle would
 * divide the labour bill by nothing.
 */
async function itemUpsert(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  if (!isUuid(m.id)) return reject(m, 'BAD_ID', 'id must be a UUID');
  const d = m.data ?? {};
  const name = readText(d.name, 160);
  if (!name) bad('name is required');
  const kind = d.kind === 'steel' ? 'steel' : 'material';
  const unit = readText(d.unit, MATERIAL_UNITS) || 'pcs';
  if (kind === 'steel' && unit !== 'pcs' && unit !== 'kg') bad("steel is counted in 'pcs' or 'kg'");
  const categories = ['bindingWire', 'coverBlock', 'chemical', 'other'];
  const category = kind === 'steel' ? 'steel' : categories.includes(d.category) ? d.category : 'other';
  const sizes = kind !== 'steel' ? [] : (Array.isArray(d.sizes) ? d.sizes : []).map((z: any, i: number) => {
    if (!Number.isInteger(z?.sizeMm) || z.sizeMm <= 0 || z.sizeMm > 100) bad(`sizes[${i}].sizeMm must be a whole number of mm`);
    const rods = z.rodsPerBundle;
    if (typeof rods !== 'number' || !Number.isFinite(rods) || rods < 0 || rods > 10_000) bad(`sizes[${i}].rodsPerBundle is out of range`);
    const kg = z.kgPerRod;
    if (typeof kg !== 'number' || !Number.isFinite(kg) || kg < 0 || kg > 1000) bad(`sizes[${i}].kgPerRod is out of range`);
    return { sizeMm: z.sizeMm, rodsPerBundle: rods, kgPerRod: kg };
  });
  const order = Number.isInteger(d.order) && d.order >= 0 && d.order <= 1_000_000 ? d.order : 0;
  await ctx.c.query(
    `INSERT INTO material_items (firm_id, id, kind, name, unit, category, sizes, load_rate, unload_rate, sort_order, updated_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (firm_id, id) DO UPDATE SET
       kind = excluded.kind, name = excluded.name, unit = excluded.unit, category = excluded.category,
       sizes = excluded.sizes, load_rate = excluded.load_rate, unload_rate = excluded.unload_rate,
       sort_order = excluded.sort_order, deleted_at = NULL, rev = rev + 1, updated_by = excluded.updated_by`,
    [ctx.firmId, m.id, kind, name, unit, category, JSON.stringify(sizes), readRate(d.loadRate, 'loadRate'),
     readRate(d.unloadRate, 'unloadRate'), order, ctx.userId],
  );
  const [rows] = await ctx.c.query('SELECT rev FROM material_items WHERE firm_id = ? AND id = ?', [ctx.firmId, m.id]);
  return applied(m, Number((rows as any[])[0].rev));
}

async function itemDelete(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  if (!isUuid(m.id)) return reject(m, 'BAD_ID', 'id must be a UUID');
  const used = await depotUsage(ctx.c, ctx.firmId, 'materialItem', m.id);
  if (used > 0) {
    return reject(m, 'BUSINESS_RULE_VIOLATION', `Still used by ${used} steel / material entr${used === 1 ? 'y' : 'ies'}; delete those first`);
  }
  await softDeleteRow(ctx.c, 'material_items', ctx.firmId, m.id, ctx.userId);
  return applied(m, (m.rev ?? 0) + 1);
}

/**
 * Reject on rev mismatch, like freight entries: a diary line is a record of
 * what happened, and two phones disagreeing about it is for a person to
 * settle. An omitted rev on a row that exists *is* a mismatch.
 */
async function recordUpsert(ctx: Ctx, m: Mutation, def: RecordDef): Promise<PushOutcome> {
  if (!isUuid(m.id)) return reject(m, 'BAD_ID', 'id must be a UUID');
  const cols = def.columns(m.data ?? {});
  const [rows] = await ctx.c.query(`SELECT * FROM ${def.table} WHERE firm_id = ? AND id = ?`, [ctx.firmId, m.id]);
  const existing = (rows as any[])[0];
  const names = Object.keys(cols);
  if (!existing) {
    await ctx.c.query(
      `INSERT INTO ${def.table} (firm_id, id, ${names.join(', ')}, updated_by) VALUES (?, ?, ${names.map(() => '?').join(', ')}, ?)`,
      [ctx.firmId, m.id, ...Object.values(cols), ctx.userId],
    );
    return applied(m, 1);
  }
  if (m.rev === undefined || m.rev !== Number(existing.rev) || existing.deleted_at !== null) {
    return conflict(m, def.map(existing));
  }
  await ctx.c.query(
    `UPDATE ${def.table} SET ${names.map((n) => `${n} = ?`).join(', ')}, rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ?`,
    [...Object.values(cols), ctx.userId, ctx.firmId, m.id],
  );
  return applied(m, Number(existing.rev) + 1);
}

async function recordDelete(ctx: Ctx, m: Mutation, def: RecordDef): Promise<PushOutcome> {
  const [rows] = await ctx.c.query(`SELECT * FROM ${def.table} WHERE firm_id = ? AND id = ?`, [ctx.firmId, m.id]);
  const existing = (rows as any[])[0];
  // Already gone is success: the outcome the client asked for is true.
  if (!existing || existing.deleted_at) return applied(m, m.rev ?? 0);
  if (m.rev === undefined || m.rev !== Number(existing.rev)) return conflict(m, def.map(existing));
  await softDeleteRow(ctx.c, def.table, ctx.firmId, m.id, ctx.userId);
  await def.afterDelete?.(ctx, m.id);
  return applied(m, Number(existing.rev) + 1);
}

// ---------------------------------------------------------------- usage

/**
 * How many live diary rows point at a master — the guard deleteWithCascade
 * consults before letting a party, company, grade or labour go. Grades live
 * inside the JSON maps, so they are found with `json_each`.
 */
export async function depotUsage(
  c: Q,
  firmId: string,
  kind: 'party' | 'company' | 'grade' | 'labour' | 'materialItem',
  id: string,
): Promise<number> {
  const live = 'firm_id = ? AND deleted_at IS NULL';
  let sql: string;
  let params: unknown[];
  switch (kind) {
    case 'party':
      sql = `SELECT (SELECT COUNT(*) FROM depot_dispatches WHERE ${live} AND party_id = ?)
                  + (SELECT COUNT(*) FROM material_moves WHERE ${live} AND party_id = ?) AS n`;
      params = [firmId, id, firmId, id];
      break;
    case 'materialItem':
      sql = `SELECT COUNT(*) AS n FROM material_moves t WHERE t.firm_id = ? AND t.deleted_at IS NULL
               AND EXISTS (SELECT 1 FROM json_each(t.lines) j WHERE json_extract(j.value, '$.itemId') = ?)`;
      params = [firmId, id];
      break;
    case 'company':
      sql = `SELECT (SELECT COUNT(*) FROM depot_trucks WHERE ${live} AND company_id = ?)
                  + (SELECT COUNT(*) FROM depot_dispatches WHERE ${live} AND company_id = ?)
                  + (SELECT COUNT(*) FROM depot_adjustments WHERE ${live} AND company_id = ?) AS n`;
      params = [firmId, id, firmId, id, firmId, id];
      break;
    case 'labour':
      sql = `SELECT (SELECT COUNT(*) FROM depot_trucks WHERE ${live} AND labour_id = ?)
                  + (SELECT COUNT(*) FROM depot_dispatches WHERE ${live} AND labour_id = ?)
                  + (SELECT COUNT(*) FROM material_moves WHERE ${live} AND labour_id = ?) AS n`;
      params = [firmId, id, firmId, id, firmId, id];
      break;
    case 'grade': {
      const inMap = (table: string, col: string) =>
        `(SELECT COUNT(*) FROM ${table} t WHERE t.firm_id = ? AND t.deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM json_each(t.${col}) j WHERE j.key = ?))`;
      sql = `SELECT ${[
        inMap('depot_trucks', 'received_bags'),
        inMap('depot_trucks', 'godown_bags'),
        inMap('depot_trucks', 'short_bags'),
        inMap('depot_dispatches', 'grade_bags'),
        inMap('depot_adjustments', 'grade_bags'),
      ].join(' + ')} AS n`;
      params = Array.from({ length: 5 }, () => [firmId, id]).flat();
      break;
    }
  }
  const [rows] = await c.query(sql, params);
  return Number((rows as any[])[0]?.n ?? 0);
}
