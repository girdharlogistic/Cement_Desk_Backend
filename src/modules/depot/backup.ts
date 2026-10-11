/**
 * The depot diary's part of the JSON backup, both directions.
 *
 * Import is deliberately forgiving where the rest of backupImport is strict:
 * a diary line that points at a customer or company the file does not carry
 * is dropped with a warning instead of failing the whole upload. The diary is
 * the newest thing in the file, and the dealer's freight vouchers and claims
 * must not become impossible to restore because of one stray truck.
 */
import { Q } from '../../db/pool';
import { parseBusinessDate } from '../../lib/dates';
import { isUuid } from '../../lib/ids';
import { num } from '../../lib/num';
import { DepotInvalid, readGradeBags } from './service';

export interface DepotRefs {
  parties: Set<string>;
  companies: Set<string>;
  grades: Set<string>;
  labours: Set<string>;
}

export interface DepotPlan {
  labours: { id: string; name: string; phone: string | null; order: number }[];
  materialItems: any[];
  materialMoves: any[];
  settings: { unloadRate: number; directRate: number; loadRate: number } | null;
  trucks: any[];
  dispatches: any[];
  adjustments: any[];
}

function rows(body: any, key: string): any[] {
  const v = body?.[key];
  return Array.isArray(v) ? v : [];
}

function rate(v: unknown): number {
  const n = num(v);
  return n >= 0 && n <= 100_000 ? n : 0;
}

export function planDepot(body: any, refs: DepotRefs, warnings: string[]): DepotPlan {
  const labours = rows(body, 'labours').flatMap((r, i) => {
    if (!isUuid(r?.id) || typeof r?.name !== 'string' || !r.name.trim()) {
      warnings.push(`labours[${i}]: needs an id and a name — skipped`);
      return [];
    }
    return [{ id: r.id, name: String(r.name).trim().slice(0, 160), phone: r?.phone ? String(r.phone).slice(0, 20) : null, order: Math.max(0, Math.trunc(num(r?.order))) }];
  });
  const labourIds = new Set([...refs.labours, ...labours.map((l) => l.id)]);

  const s = rows(body, 'depotSettings')[0];
  const settings = s ? { unloadRate: rate(s.unloadRate), directRate: rate(s.directRate), loadRate: rate(s.loadRate) } : null;

  /** Grade keys the file knows; the rest are dropped, loudly. */
  const grades = (v: unknown, where: string, signed = false): Record<string, number> | null => {
    let g: Record<string, number>;
    try {
      g = readGradeBags(v, where, { signed });
    } catch (e) {
      if (e instanceof DepotInvalid) { warnings.push(`${where}: ${e.message} — skipped`); return null; }
      throw e;
    }
    for (const k of Object.keys(g)) {
      if (!refs.grades.has(k)) { warnings.push(`${where}: unknown grade '${k}' dropped`); delete g[k]; }
    }
    return g;
  };
  const labour = (v: unknown, where: string): string | null => {
    if (!v) return null;
    if (isUuid(v) && labourIds.has(v)) return v;
    warnings.push(`${where}: unknown labour '${String(v)}' cleared`);
    return null;
  };
  const head = (r: any, entity: string, i: number) => {
    const date = parseBusinessDate(r?.date);
    if (!isUuid(r?.id) || !date) { warnings.push(`${entity}[${i}]: needs an id and a date — skipped`); return null; }
    if (!refs.companies.has(r?.companyId)) { warnings.push(`${entity}[${i}]: unknown company — skipped`); return null; }
    return { id: r.id as string, date, companyId: r.companyId as string, note: String(r?.note ?? '').slice(0, 500) };
  };

  const trucks = rows(body, 'depotTrucks').flatMap((r, i) => {
    const h = head(r, 'depotTrucks', i);
    const received = h && grades(r?.received, `depotTrucks[${i}].received`);
    const godown = received && grades(r?.godown, `depotTrucks[${i}].godown`);
    const short = godown && grades(r?.short, `depotTrucks[${i}].short`);
    if (!h || !received || !godown || !short) return [];
    if (!Object.keys(received).length) { warnings.push(`depotTrucks[${i}]: no bags received — skipped`); return []; }
    return [{
      ...h, truckNo: String(r?.truckNo ?? '').toUpperCase().slice(0, 40), ref: String(r?.ref ?? '').slice(0, 80),
      received, godown, short, labourId: labour(r?.labourId, `depotTrucks[${i}]`), unloadRate: rate(r?.unloadRate),
    }];
  });
  const truckIds = new Set(trucks.map((t) => t.id));

  const dispatches = rows(body, 'depotDispatches').flatMap((r, i) => {
    const h = head(r, 'depotDispatches', i);
    if (!h) return [];
    if (!refs.parties.has(r?.partyId)) { warnings.push(`depotDispatches[${i}]: unknown customer — skipped`); return []; }
    const gradeBags = grades(r?.gradeBags, `depotDispatches[${i}].gradeBags`);
    if (!gradeBags || !Object.keys(gradeBags).length) { warnings.push(`depotDispatches[${i}]: no bags — skipped`); return []; }
    // A direct delivery whose truck did not make it into the file is still a
    // delivery that happened; it is kept as one from the godown rather than
    // lost, and said so.
    let source = r?.source === 'truck' ? 'truck' : 'godown';
    let truckId: string | null = source === 'truck' ? r?.truckId ?? null : null;
    if (source === 'truck' && !truckIds.has(truckId as string)) {
      warnings.push(`depotDispatches[${i}]: its truck is not in the backup — kept as a godown dispatch`);
      source = 'godown';
      truckId = null;
    }
    return [{
      ...h, source, truckId, partyId: r.partyId, address: String(r?.address ?? '').slice(0, 300),
      vehicleNo: String(r?.vehicleNo ?? '').toUpperCase().slice(0, 40), gradeBags,
      labourId: labour(r?.labourId, `depotDispatches[${i}]`), labourRate: rate(r?.labourRate),
      freightEntryId: isUuid(r?.freightEntryId) ? r.freightEntryId : null,
    }];
  });

  const adjustments = rows(body, 'depotAdjustments').flatMap((r, i) => {
    const h = head(r, 'depotAdjustments', i);
    if (!h) return [];
    const kind = ['opening', 'damage', 'correction'].includes(r?.kind) ? r.kind : null;
    if (!kind) { warnings.push(`depotAdjustments[${i}]: unknown kind — skipped`); return []; }
    const gradeBags = grades(r?.gradeBags, `depotAdjustments[${i}].gradeBags`, kind !== 'opening');
    if (!gradeBags) return [];
    return [{ ...h, kind, gradeBags }];
  });

  // ---- steel and material ----
  const materialItems = rows(body, 'materialItems').flatMap((r, i) => {
    if (!isUuid(r?.id) || typeof r?.name !== 'string' || !r.name.trim()) {
      warnings.push(`materialItems[${i}]: needs an id and a name — skipped`);
      return [];
    }
    const kind = r.kind === 'steel' ? 'steel' : 'material';
    const unit = String(r?.unit ?? 'pcs').slice(0, 12) || 'pcs';
    const sizes = kind !== 'steel' ? [] : (Array.isArray(r.sizes) ? r.sizes : []).flatMap((z: any) =>
      Number.isInteger(z?.sizeMm) && z.sizeMm > 0 && z.sizeMm <= 100
        ? [{ sizeMm: z.sizeMm, rodsPerBundle: Math.max(0, num(z.rodsPerBundle)), kgPerRod: Math.max(0, num(z.kgPerRod)) }]
        : []);
    return [{
      id: r.id, kind, name: String(r.name).trim().slice(0, 160),
      unit: kind === 'steel' && unit !== 'kg' ? 'pcs' : unit,
      category: kind === 'steel' ? 'steel' : ['bindingWire', 'coverBlock', 'chemical', 'other'].includes(r?.category) ? r.category : 'other',
      sizes, loadRate: rate(r?.loadRate), unloadRate: rate(r?.unloadRate), order: Math.max(0, Math.trunc(num(r?.order))),
    }];
  });
  const itemIds = new Set(materialItems.map((x) => x.id));
  const materialMoves = rows(body, 'materialMoves').flatMap((r, i) => {
    const date = parseBusinessDate(r?.date);
    if (!isUuid(r?.id) || !date) { warnings.push(`materialMoves[${i}]: needs an id and a date — skipped`); return []; }
    const kind = ['receive', 'dispatch', 'opening', 'adjust'].includes(r?.kind) ? r.kind : null;
    if (!kind) { warnings.push(`materialMoves[${i}]: unknown kind — skipped`); return []; }
    const partyId = isUuid(r?.partyId) && refs.parties.has(r.partyId) ? r.partyId : null;
    if (kind === 'dispatch' && !partyId) { warnings.push(`materialMoves[${i}]: unknown customer — skipped`); return []; }
    const lines = (Array.isArray(r?.lines) ? r.lines : []).flatMap((l: any) =>
      isUuid(l?.itemId) && itemIds.has(l.itemId) && Number.isFinite(l?.qty) && Math.abs(l.qty) > 1e-9
        ? [{ itemId: l.itemId, sizeMm: Number.isInteger(l?.sizeMm) ? l.sizeMm : 0, qty: l.qty, bundles: Math.max(0, num(l?.bundles)), rate: rate(l?.rate) }]
        : []);
    if (!lines.length) { warnings.push(`materialMoves[${i}]: no lines for known items — skipped`); return []; }
    return [{
      id: r.id, date, kind, partyId, supplier: String(r?.supplier ?? '').slice(0, 160),
      address: String(r?.address ?? '').slice(0, 300), vehicleNo: String(r?.vehicleNo ?? '').toUpperCase().slice(0, 40),
      labourId: labour(r?.labourId, `materialMoves[${i}]`), lines, note: String(r?.note ?? '').slice(0, 500),
    }];
  });

  return { labours, settings, trucks, dispatches, adjustments, materialItems, materialMoves };
}

/** Tables a replace-mode import tombstones before writing the file's rows. */
export const DEPOT_REPLACE_TABLES = [
  'labours', 'depot_trucks', 'depot_dispatches', 'depot_adjustments', 'material_items', 'material_moves',
];

type Upsert = (c: Q, table: string, cols: string[], vals: unknown[]) => Promise<void>;
type Write = (label: string, rows: unknown[][], fn: (c: Q, r: unknown[]) => Promise<void>) => Promise<void>;

/** Labours and material items first — the diary rows name them. */
export async function writeDepotLabours(p: DepotPlan, firmId: string, userId: string, write: Write, upsert: Upsert): Promise<void> {
  await write('labours', p.labours as any, (c, r: any) =>
    upsert(c, 'labours', ['firm_id', 'id', 'name', 'phone', 'sort_order', 'updated_by'], [firmId, r.id, r.name, r.phone, r.order, userId]));
  await write('materialItems', p.materialItems as any, (c, r: any) =>
    upsert(c, 'material_items',
      ['firm_id', 'id', 'kind', 'name', 'unit', 'category', 'sizes', 'load_rate', 'unload_rate', 'sort_order', 'updated_by'],
      [firmId, r.id, r.kind, r.name, r.unit, r.category, JSON.stringify(r.sizes), r.loadRate, r.unloadRate, r.order, userId]));
}

export async function writeDepotRecords(
  p: DepotPlan,
  firmId: string,
  userId: string,
  write: Write,
  upsert: Upsert,
  tx: (fn: (c: Q) => Promise<void>) => Promise<void>,
): Promise<boolean> {
  if (p.settings) {
    const st = p.settings;
    await tx(async (c) => {
      await c.query(
        `INSERT INTO depot_settings (firm_id, unload_rate, direct_rate, load_rate, updated_by) VALUES (?,?,?,?,?)
         ON CONFLICT (firm_id) DO UPDATE SET unload_rate = excluded.unload_rate, direct_rate = excluded.direct_rate,
           load_rate = excluded.load_rate, deleted_at = NULL, rev = rev + 1, updated_by = excluded.updated_by`,
        [firmId, st.unloadRate, st.directRate, st.loadRate, userId],
      );
    });
  }
  await write('depotTrucks', p.trucks as any, (c, r: any) =>
    upsert(c, 'depot_trucks',
      ['firm_id', 'id', 'date', 'company_id', 'truck_no', 'ref', 'received_bags', 'godown_bags', 'short_bags', 'labour_id', 'unload_rate', 'note', 'updated_by'],
      [firmId, r.id, r.date, r.companyId, r.truckNo, r.ref, JSON.stringify(r.received), JSON.stringify(r.godown), JSON.stringify(r.short), r.labourId, r.unloadRate, r.note, userId]));
  await write('depotDispatches', p.dispatches as any, (c, r: any) =>
    upsert(c, 'depot_dispatches',
      ['firm_id', 'id', 'date', 'company_id', 'source', 'truck_id', 'party_id', 'address', 'vehicle_no', 'grade_bags', 'labour_id', 'labour_rate', 'note', 'freight_entry_id', 'updated_by'],
      [firmId, r.id, r.date, r.companyId, r.source, r.truckId, r.partyId, r.address, r.vehicleNo, JSON.stringify(r.gradeBags), r.labourId, r.labourRate, r.note, r.freightEntryId, userId]));
  await write('depotAdjustments', p.adjustments as any, (c, r: any) =>
    upsert(c, 'depot_adjustments',
      ['firm_id', 'id', 'date', 'company_id', 'kind', 'grade_bags', 'note', 'updated_by'],
      [firmId, r.id, r.date, r.companyId, r.kind, JSON.stringify(r.gradeBags), r.note, userId]));
  await write('materialMoves', p.materialMoves as any, (c, r: any) =>
    upsert(c, 'material_moves',
      ['firm_id', 'id', 'date', 'kind', 'party_id', 'supplier', 'address', 'vehicle_no', 'labour_id', 'lines', 'note', 'updated_by'],
      [firmId, r.id, r.date, r.kind, r.partyId, r.supplier, r.address, r.vehicleNo, r.labourId, JSON.stringify(r.lines), r.note, userId]));
  return p.settings !== null;
}

/** Export side: the same keys the app's backup writes and reads. */
export function exportDepot(
  firmId: string,
  labours: any[],
  settings: any[],
  trucks: any[],
  dispatches: any[],
  adjustments: any[],
  items: any[] = [],
  moves: any[] = [],
): Record<string, unknown[]> {
  const live = (rs: any[]) => rs.filter((r) => !r.deleted_at);
  const json = (v: unknown) => {
    try {
      const o = JSON.parse(String(v ?? '{}'));
      return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    } catch {
      return {};
    }
  };
  const list = (v: unknown) => {
    try {
      const o = JSON.parse(String(v ?? '[]'));
      return Array.isArray(o) ? o : [];
    } catch {
      return [];
    }
  };
  return {
    labours: live(labours).map((r) => ({ id: r.id, firmId, name: r.name, phone: r.phone ?? null, order: Number(r.sort_order) })),
    depotSettings: live(settings).map((r) => ({
      firmId, unloadRate: num(r.unload_rate), directRate: num(r.direct_rate), loadRate: num(r.load_rate),
    })),
    depotTrucks: live(trucks).map((r) => ({
      id: r.id, firmId, date: r.date, companyId: r.company_id, truckNo: r.truck_no, ref: r.ref,
      received: json(r.received_bags), godown: json(r.godown_bags), short: json(r.short_bags),
      labourId: r.labour_id ?? null, unloadRate: num(r.unload_rate), note: r.note ?? '',
    })),
    depotDispatches: live(dispatches).map((r) => ({
      id: r.id, firmId, date: r.date, companyId: r.company_id, source: r.source, truckId: r.truck_id ?? null,
      partyId: r.party_id, address: r.address ?? '', vehicleNo: r.vehicle_no ?? '', gradeBags: json(r.grade_bags),
      labourId: r.labour_id ?? null, labourRate: num(r.labour_rate), note: r.note ?? '',
      freightEntryId: r.freight_entry_id ?? null,
    })),
    depotAdjustments: live(adjustments).map((r) => ({
      id: r.id, firmId, date: r.date, companyId: r.company_id, kind: r.kind, gradeBags: json(r.grade_bags), note: r.note ?? '',
    })),
    materialItems: live(items).map((r) => ({
      id: r.id, firmId, kind: r.kind, name: r.name, unit: r.unit, category: r.category, sizes: list(r.sizes),
      loadRate: num(r.load_rate), unloadRate: num(r.unload_rate), order: Number(r.sort_order),
    })),
    materialMoves: live(moves).map((r) => ({
      id: r.id, firmId, date: r.date, kind: r.kind, partyId: r.party_id ?? null, supplier: r.supplier ?? '',
      address: r.address ?? '', vehicleNo: r.vehicle_no ?? '', labourId: r.labour_id ?? null, lines: list(r.lines),
      note: r.note ?? '',
    })),
  };
}
