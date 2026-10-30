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
    customer: r.customer ?? '',
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
    // A return's dealer, customer and gang (0008). Empty on the other kinds.
    partyId: r.party_id ?? null,
    customer: r.customer ?? '',
    address: r.address ?? '',
    vehicleNo: r.vehicle_no ?? '',
    labourId: r.labour_id ?? null,
    labourRate: num(r.labour_rate),
    ...syncMeta(r),
  };
}

export function mapSteelTest(r: any): any {
  let samples: unknown = [];
  try {
    samples = JSON.parse(String(r.samples ?? '[]'));
  } catch {
    samples = [];
  }
  return {
    id: r.id,
    firmId: r.firm_id,
    date: r.date,
    sizeMm: Number(r.size_mm),
    createdBy: r.created_by ?? '',
    createdFor: r.created_for ?? '',
    note: r.note ?? '',
    lengthUnit: r.length_unit ?? 'mm',
    samples: Array.isArray(samples) ? samples : [],
    ...syncMeta(r),
  };
}

function jsonOf<T>(v: unknown, fallback: T, ok: (o: unknown) => boolean): T {
  try {
    const o = JSON.parse(String(v ?? ''));
    return ok(o) ? (o as T) : fallback;
  } catch {
    return fallback;
  }
}

export function mapSteelBrand(r: any): any {
  return {
    id: r.id,
    firmId: r.firm_id,
    name: r.name,
    mode: r.mode,
    rateUnit: r.rate_unit,
    barLengthM: num(r.bar_length_m),
    sizes: jsonOf(r.sizes, [], Array.isArray),
    rateUpdatedAt: r.rate_updated_at,
    order: Number(r.sort_order),
    ...syncMeta(r),
  };
}

export function mapSteelEstimate(r: any): any {
  return {
    id: r.id,
    firmId: r.firm_id,
    brandId: r.brand_id ?? null,
    brandName: r.brand_name ?? '',
    mode: r.mode,
    customer: r.customer ?? '',
    writtenAt: r.written_at,
    lines: jsonOf(r.lines, [], Array.isArray),
    bindingWireKg: num(r.binding_wire_kg),
    bindingWireRate: num(r.binding_wire_rate),
    coverBlockQty: num(r.cover_block_qty),
    coverBlockRate: num(r.cover_block_rate),
    freightMode: r.freight_mode,
    freightValue: num(r.freight_value),
    loadingMode: r.loading_mode,
    loadingCharges: num(r.loading_charges),
    discountPct: num(r.discount_pct),
    discountScope: r.discount_scope,
    gstPct: num(r.gst_pct),
    compareBrandIds: jsonOf(r.compare_brand_ids, [], Array.isArray),
    compareBasis: r.compare_basis,
    compareDiscounts: jsonOf(r.compare_discounts, {}, (o) => !!o && typeof o === 'object' && !Array.isArray(o)),
    ...syncMeta(r),
  };
}

export function mapDepotDayNote(r: any): any {
  return {
    id: r.id,
    firmId: r.firm_id,
    date: r.date,
    section: r.section,
    companyId: r.company_id ?? null,
    text: r.text ?? '',
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
    customer: r.customer ?? '',
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
      case 'depotDayNotes':
        return m.op === 'upsert' ? await recordUpsert(ctx, m, DAY_NOTES) : await recordDelete(ctx, m, DAY_NOTES);
      case 'steelTests':
        return m.op === 'upsert' ? await recordUpsert(ctx, m, STEEL_TESTS) : await recordDelete(ctx, m, STEEL_TESTS);
      case 'steelBrands':
        return m.op === 'upsert' ? await steelBrandUpsert(ctx, m) : await steelBrandDelete(ctx, m);
      case 'steelEstimates':
        return m.op === 'upsert' ? await recordUpsert(ctx, m, STEEL_ESTIMATES) : await recordDelete(ctx, m, STEEL_ESTIMATES);
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
  table: 'depot_trucks' | 'depot_dispatches' | 'depot_adjustments' | 'material_moves' | 'depot_day_notes' | 'steel_tests'
    | 'steel_estimates';
  /** Validated wire data → column values, in a fixed column order. */
  columns(d: any): Record<string, unknown>;
  /**
   * Adjusts an update's columns against the row it replaces — for what an
   * app from before a kind existed cannot know to send. Mutates [cols].
   */
  carry?(cols: Record<string, unknown>, existing: any, d: any): void;
  /**
   * A tombstoned row may be written again instead of conflicting. Only for
   * rows whose id the app derives from what they are about (day notes): a
   * derived id never changes, so a tombstone would refuse it forever.
   */
  revive?: boolean;
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

/**
 * The dealer's customer, only when sent. `partyId` is the dealer; this is who
 * the dealer sold to. An app from before the field existed edits a dispatch
 * without the key, and that edit must not wipe a customer a newer phone
 * wrote — the same rule as the freight link below.
 */
function customerColumn(d: any): { customer?: string } {
  return 'customer' in d ? { customer: readText(d.customer, 160) } : {};
}

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
      ...customerColumn(d),
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
    const kind = (['opening', 'damage', 'correction', 'returned'] as const).includes(d.kind)
      ? d.kind
      : bad("kind must be 'opening', 'damage', 'correction' or 'returned'");
    // A correction goes either way; an opening and a return only add and a
    // burst bag only takes away, so those are held to their sign.
    const gradeBags = readGradeBags(d.gradeBags, 'gradeBags', { signed: kind === 'correction' || kind === 'damage' });
    if (kind === 'damage' && Object.values(gradeBags).some((v) => v > 0)) bad('Damaged bags are recorded as a negative number');
    if (kind === 'returned' && total(gradeBags) <= 0) bad('A return needs the bags that came back');
    if (!isUuid(d.companyId)) bad('companyId must be a UUID');
    const partyId = readOptionalId(d.partyId, 'partyId');
    if (kind === 'returned' && !partyId) bad('A return needs the dealer');
    return {
      date: readDate(d.date),
      company_id: d.companyId,
      kind,
      grade_bags: JSON.stringify(gradeBags),
      note: readText(d.note, 500),
      // Only when sent. An app from before returns edits an opening or a
      // correction without these keys, and must not blank a return's dealer.
      ...('partyId' in d
        ? {
            party_id: kind === 'returned' ? partyId : null,
            customer: kind === 'returned' ? readText(d.customer, 160) : '',
            address: kind === 'returned' ? readText(d.address, 300) : '',
            vehicle_no: kind === 'returned' ? readText(d.vehicleNo, 40).toUpperCase() : '',
            labour_id: kind === 'returned' ? readOptionalId(d.labourId, 'labourId') : null,
            labour_rate: kind === 'returned' ? readRate(d.labourRate, 'labourRate') : 0,
          }
        : {}),
    };
  },
  // An app from before returns reads one as a count correction and, if it
  // edits it, sends kind 'correction' with none of the return's keys. The row
  // stays a return; that app's bag count still lands.
  carry(cols, existing, d) {
    if (existing.kind === 'returned' && !('partyId' in d)) {
      cols.kind = 'returned';
      const bags = parseJson(cols.grade_bags);
      if (total(bags) <= 0 || Object.values(bags).some((v) => v < 0)) bad('A return needs the bags that came back');
    }
  },
  map: mapDepotAdjustment,
};

const DAY_SECTIONS = ['cement', 'steel', 'chemical', 'sandGitti'] as const;

/**
 * The note for one day of one tab of the diary — per company on the cement
 * tab. The app derives the id from (date, section, company), so a second
 * phone writing the same day's note lands on the same row and is told about
 * the first, the same as any diary edit. Emptying a note saves it empty.
 */
const DAY_NOTES: RecordDef = {
  table: 'depot_day_notes',
  columns(d) {
    const section = (DAY_SECTIONS as readonly string[]).includes(d.section)
      ? d.section
      : bad(`section must be one of ${DAY_SECTIONS.join(', ')}`);
    const companyId = readOptionalId(d.companyId, 'companyId');
    if (section === 'cement' && !companyId) bad('A cement day note needs the company');
    return {
      date: readDate(d.date),
      section,
      company_id: section === 'cement' ? companyId : null,
      text: readText(d.text, 2000),
    };
  },
  revive: true,
  map: mapDepotDayNote,
};

const STEEL_GRADES = ['fe415', 'fe500', 'fe500d', 'fe550', 'fe550d', 'fe600'] as const;
const STEEL_RATE_UNITS = ['perPiece', 'perKg', 'perQuintal', 'perTonne'] as const;

/**
 * A sariya test: one bar size, one to four measured pieces. The server checks
 * shape — a real size, sane lengths and weights, a known grade — and keeps
 * the measurements; every figure the report shows is the app's arithmetic.
 * Rides the diary's record machinery: reject on rev mismatch, soft delete.
 */
const STEEL_TESTS: RecordDef = {
  table: 'steel_tests',
  columns(d) {
    const size = d.sizeMm;
    if (!Number.isInteger(size) || size < 4 || size > 60) bad('sizeMm must be a bar size in mm');
    if (!Array.isArray(d.samples) || d.samples.length < 1 || d.samples.length > 4) bad('A test has one to four samples');
    const samples = (d.samples as any[]).map((s, i) => {
      if (!s || typeof s !== 'object') bad(`samples[${i}] must be an object`);
      const measure = (v: unknown, field: string, max: number) => {
        const n = v === undefined || v === null ? 0 : v;
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > max) bad(`samples[${i}].${field} is out of range`);
        return n as number;
      };
      const grade = (STEEL_GRADES as readonly string[]).includes(s.grade) ? s.grade : bad(`samples[${i}].grade must be one of ${STEEL_GRADES.join(', ')}`);
      const rateUnit = s.rateUnit === undefined || s.rateUnit === null
        ? 'perPiece'
        : (STEEL_RATE_UNITS as readonly string[]).includes(s.rateUnit) ? s.rateUnit : bad(`samples[${i}].rateUnit is not a rate unit`);
      return {
        brand: readText(s.brand, 80),
        grade,
        lengthMm: measure(s.lengthMm, 'lengthMm', 20_000),
        weightG: measure(s.weightG, 'weightG', 200_000),
        rate: measure(s.rate, 'rate', 10_000_000),
        rateUnit,
      };
    });
    const unit = d.lengthUnit === 'cm' || d.lengthUnit === 'inch' ? d.lengthUnit : 'mm';
    return {
      date: readDate(d.date),
      size_mm: size,
      created_by: readText(d.createdBy, 120),
      created_for: readText(d.createdFor, 160),
      note: readText(d.note, 1000),
      length_unit: unit,
      samples: JSON.stringify(samples),
    };
  },
  map: mapSteelTest,
};

// ---------------------------------------------------------- steel estimator

const STEEL_MODES = ['perPiece', 'perKg'] as const;
const MAX_AMOUNT = 10_000_000;

/** An ISO-8601 date and time, kept as sent (see 0010 for why not a day). */
function readInstant(v: unknown, field: string): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/.test(v)
      || Number.isNaN(Date.parse(v))) {
    bad(`${field} must be an ISO-8601 date and time`);
  }
  return v;
}

/** One of [values]; [fallback] when the key is absent, refused when unknown. */
function readEnum<T extends string>(v: unknown, field: string, values: readonly T[], fallback: T): T {
  if (v === undefined || v === null) return fallback;
  return (values as readonly unknown[]).includes(v) ? (v as T) : bad(`${field} must be one of ${values.join(', ')}`);
}

function readAmount(v: unknown, field: string, max = MAX_AMOUNT): number {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) bad(`${field} is out of range`);
  return v;
}

function readBarSize(v: unknown, field: string): number {
  if (!Number.isInteger(v) || (v as number) < 4 || (v as number) > 60) bad(`${field} must be a bar size in mm`);
  return v as number;
}

function readCount(v: unknown, field: string): number {
  const n = v === undefined || v === null ? 0 : v;
  if (!Number.isInteger(n) || (n as number) < 0 || (n as number) > 10_000) bad(`${field} must be a whole number`);
  return n as number;
}

/**
 * A steel brand is a master: last write wins, like material items. Its size
 * list is checked for shape because every estimate does arithmetic with it —
 * one entry per bar size, the rate stored per kg whatever unit it was typed
 * in.
 */
async function steelBrandUpsert(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  if (!isUuid(m.id)) return reject(m, 'BAD_ID', 'id must be a UUID');
  const d = m.data ?? {};
  const name = readText(d.name, 160);
  if (!name) bad('name is required');
  const mode = readEnum(d.mode, 'mode', STEEL_MODES, 'perPiece');
  const rateUnit = readEnum(d.rateUnit, 'rateUnit', STEEL_MODES, 'perPiece');
  const barLength = d.barLengthM === undefined || d.barLengthM === null ? 12 : d.barLengthM;
  if (typeof barLength !== 'number' || !Number.isFinite(barLength) || barLength <= 0 || barLength > 30) bad('barLengthM must be a rod length in metres');
  if (d.sizes !== undefined && d.sizes !== null && !Array.isArray(d.sizes)) bad('sizes must be a list');
  const raw: any[] = Array.isArray(d.sizes) ? d.sizes : [];
  if (raw.length > 20) bad('Too many sizes on one brand');
  const seen = new Set<number>();
  const sizes = raw.map((s, i) => {
    if (!s || typeof s !== 'object') bad(`sizes[${i}] must be an object`);
    const sizeMm = readBarSize(s.sizeMm, `sizes[${i}].sizeMm`);
    if (seen.has(sizeMm)) bad(`sizes[${i}]: ${sizeMm} mm is listed twice`);
    seen.add(sizeMm);
    return {
      sizeMm,
      lengthsPerBundle: readCount(s.lengthsPerBundle, `sizes[${i}].lengthsPerBundle`),
      kgPerRod: readAmount(s.kgPerRod, `sizes[${i}].kgPerRod`, 1000),
      ratePerKg: readAmount(s.ratePerKg, `sizes[${i}].ratePerKg`, MAX_RATE),
    };
  });
  const order = Number.isInteger(d.order) && d.order >= 0 && d.order <= 1_000_000 ? d.order : 0;
  await ctx.c.query(
    `INSERT INTO steel_brands (firm_id, id, name, mode, rate_unit, bar_length_m, sizes, rate_updated_at, sort_order, updated_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (firm_id, id) DO UPDATE SET
       name = excluded.name, mode = excluded.mode, rate_unit = excluded.rate_unit, bar_length_m = excluded.bar_length_m,
       sizes = excluded.sizes, rate_updated_at = excluded.rate_updated_at, sort_order = excluded.sort_order,
       deleted_at = NULL, rev = rev + 1, updated_by = excluded.updated_by`,
    [ctx.firmId, m.id, name, mode, rateUnit, barLength, JSON.stringify(sizes),
     readInstant(d.rateUpdatedAt, 'rateUpdatedAt'), order, ctx.userId],
  );
  const [rows] = await ctx.c.query('SELECT rev FROM steel_brands WHERE firm_id = ? AND id = ?', [ctx.firmId, m.id]);
  return applied(m, Number((rows as any[])[0].rev));
}

/**
 * No in-use guard, unlike a material item: an estimate carries its own frozen
 * copy of every figure it took from the brand, so the mill can go and every
 * estimate written against it still reads the same.
 */
async function steelBrandDelete(ctx: Ctx, m: Mutation): Promise<PushOutcome> {
  if (!isUuid(m.id)) return reject(m, 'BAD_ID', 'id must be a UUID');
  await softDeleteRow(ctx.c, 'steel_brands', ctx.firmId, m.id, ctx.userId);
  return applied(m, (m.rev ?? 0) + 1);
}

/**
 * A steel estimate: the rows as quoted plus the charges that ride along. The
 * server checks shape — real sizes, finite non-negative figures, known modes —
 * and stores; every total the customer sees is the app's arithmetic. Rides
 * the diary's record machinery: reject on rev mismatch, soft delete.
 */
const STEEL_ESTIMATES: RecordDef = {
  table: 'steel_estimates',
  columns(d) {
    if (d.lines !== undefined && d.lines !== null && !Array.isArray(d.lines)) bad('lines must be a list');
    const raw: any[] = Array.isArray(d.lines) ? d.lines : [];
    if (raw.length > 50) bad('Too many rows on one estimate');
    const lines = raw.map((l, i) => {
      if (!l || typeof l !== 'object') bad(`lines[${i}] must be an object`);
      return {
        sizeMm: readBarSize(l.sizeMm, `lines[${i}].sizeMm`),
        pieces: readAmount(l.pieces, `lines[${i}].pieces`, MAX_BAGS),
        kg: readAmount(l.kg, `lines[${i}].kg`, MAX_BAGS),
        rate: readAmount(l.rate, `lines[${i}].rate`, MAX_RATE),
        kgPerRod: readAmount(l.kgPerRod, `lines[${i}].kgPerRod`, 1000),
        lengthsPerBundle: readCount(l.lengthsPerBundle, `lines[${i}].lengthsPerBundle`),
      };
    });
    if (d.compareBrandIds !== undefined && d.compareBrandIds !== null && !Array.isArray(d.compareBrandIds)) bad('compareBrandIds must be a list');
    const compared: unknown[] = Array.isArray(d.compareBrandIds) ? d.compareBrandIds : [];
    if (compared.length > 10) bad('Too many brands compared');
    compared.forEach((id, i) => { if (!isUuid(id)) bad(`compareBrandIds[${i}] must be a UUID`); });
    const discounts: Record<string, number> = {};
    if (d.compareDiscounts !== undefined && d.compareDiscounts !== null) {
      if (typeof d.compareDiscounts !== 'object' || Array.isArray(d.compareDiscounts)) bad('compareDiscounts must be an object of brandId → percent');
      const entries = Object.entries(d.compareDiscounts as Record<string, unknown>);
      if (entries.length > 20) bad('Too many compare discounts');
      for (const [brandId, pct] of entries) {
        if (!isUuid(brandId)) bad(`compareDiscounts: '${brandId}' is not a brand id`);
        discounts[brandId] = readAmount(pct, `compareDiscounts.${brandId}`, 100);
      }
    }
    return {
      brand_id: readOptionalId(d.brandId, 'brandId'),
      brand_name: readText(d.brandName, 160),
      mode: readEnum(d.mode, 'mode', STEEL_MODES, 'perPiece'),
      customer: readText(d.customer, 160),
      written_at: readInstant(d.writtenAt, 'writtenAt'),
      lines: JSON.stringify(lines),
      binding_wire_kg: readAmount(d.bindingWireKg, 'bindingWireKg'),
      binding_wire_rate: readAmount(d.bindingWireRate, 'bindingWireRate'),
      cover_block_qty: readAmount(d.coverBlockQty, 'coverBlockQty'),
      cover_block_rate: readAmount(d.coverBlockRate, 'coverBlockRate'),
      freight_mode: readEnum(d.freightMode, 'freightMode', ['flat', 'perTonne'] as const, 'flat'),
      freight_value: readAmount(d.freightValue, 'freightValue'),
      loading_mode: readEnum(d.loadingMode, 'loadingMode', ['flat', 'perBundle'] as const, 'flat'),
      loading_charges: readAmount(d.loadingCharges, 'loadingCharges'),
      discount_pct: readAmount(d.discountPct, 'discountPct', 100),
      discount_scope: readEnum(d.discountScope, 'discountScope', ['steelOnly', 'steelAndMaterials', 'total'] as const, 'steelOnly'),
      gst_pct: readAmount(d.gstPct, 'gstPct', 100),
      compare_brand_ids: JSON.stringify(compared),
      compare_basis: readEnum(d.compareBasis, 'compareBasis', ['pieces', 'kg'] as const, 'pieces'),
      compare_discounts: JSON.stringify(discounts),
    };
  },
  map: mapSteelEstimate,
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
    const kind = (['receive', 'dispatch', 'opening', 'adjust', 'returned'] as const).includes(d.kind)
      ? d.kind
      : bad("kind must be 'receive', 'dispatch', 'opening', 'adjust' or 'returned'");
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
    if (kind === 'dispatch' && !partyId) bad('A dispatch needs the dealer');
    if (kind === 'returned' && !partyId) bad('A return needs the dealer');
    return {
      date: readDate(d.date),
      kind,
      party_id: partyId,
      ...customerColumn(d),
      supplier: readText(d.supplier, 160),
      address: readText(d.address, 300),
      vehicle_no: readText(d.vehicleNo, 40).toUpperCase(),
      labour_id: readOptionalId(d.labourId, 'labourId'),
      lines: JSON.stringify(lines.filter((l) => Math.abs(l.qty) >= 1e-9)),
      note: readText(d.note, 500),
    };
  },
  // An app from before returns reads one as an 'adjust' and saves it back as
  // one. This app never turns a return into a correction, so that can only
  // be the older app: the row stays a return.
  carry(cols, existing) {
    if (existing.kind === 'returned' && cols.kind === 'adjust') {
      cols.kind = 'returned';
      const lines = JSON.parse(String(cols.lines)) as { qty: number }[];
      if (lines.some((l) => l.qty < 0)) bad('A return cannot take stock away');
    }
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
  const categories = ['bindingWire', 'coverBlock', 'chemical', 'other', 'sand', 'gitti'];
  let category = kind === 'steel' ? 'steel' : categories.includes(d.category) ? d.category : 'other';
  // An app from before the Sand/Gitti tab reads those categories as 'other'
  // and saves them back that way; this app never moves sand to 'other', so
  // the item keeps its tab.
  if (category === 'other') {
    const [prev] = await ctx.c.query('SELECT category FROM material_items WHERE firm_id = ? AND id = ?', [ctx.firmId, m.id]);
    const was = (prev as any[])[0]?.category;
    if (was === 'sand' || was === 'gitti') category = was;
  }
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
  const d = m.data ?? {};
  const cols = def.columns(d);
  const [rows] = await ctx.c.query(`SELECT * FROM ${def.table} WHERE firm_id = ? AND id = ?`, [ctx.firmId, m.id]);
  const existing = (rows as any[])[0];
  if (!existing) {
    const names = Object.keys(cols);
    await ctx.c.query(
      `INSERT INTO ${def.table} (firm_id, id, ${names.join(', ')}, updated_by) VALUES (?, ?, ${names.map(() => '?').join(', ')}, ?)`,
      [ctx.firmId, m.id, ...Object.values(cols), ctx.userId],
    );
    return applied(m, 1);
  }
  const revived = def.revive === true && existing.deleted_at !== null;
  if (!revived && (m.rev === undefined || m.rev !== Number(existing.rev) || existing.deleted_at !== null)) {
    return conflict(m, def.map(existing));
  }
  def.carry?.(cols, existing, d);
  const names = Object.keys(cols);
  await ctx.c.query(
    `UPDATE ${def.table} SET ${names.map((n) => `${n} = ?`).join(', ')}, deleted_at = NULL, rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ?`,
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
                  + (SELECT COUNT(*) FROM depot_adjustments WHERE ${live} AND party_id = ?)
                  + (SELECT COUNT(*) FROM material_moves WHERE ${live} AND party_id = ?) AS n`;
      params = [firmId, id, firmId, id, firmId, id];
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
                  + (SELECT COUNT(*) FROM depot_adjustments WHERE ${live} AND labour_id = ?)
                  + (SELECT COUNT(*) FROM material_moves WHERE ${live} AND labour_id = ?) AS n`;
      params = [firmId, id, firmId, id, firmId, id, firmId, id];
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
