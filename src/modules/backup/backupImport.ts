import { tx, Q } from '../../db/pool';
import { errors, ErrorDetail, isDuplicateKey } from '../../lib/errors';
import { isUuid, newId } from '../../lib/ids';
import { parseBusinessDate } from '../../lib/dates';
import { num } from '../../lib/num';
import { ensureSerialAtLeast } from '../freight/service';
import { enumFromLegacy } from './enumMaps';

export interface ImportResult {
  imported: Record<string, number>;
  warnings: string[];
}

const CHUNK = 500; // rows per transaction (§6.1 / §8.7)

type Plan = { errors: ErrorDetail[]; warnings: string[] };

function arr(body: any, key: string): any[] {
  const v = body?.[key];
  return Array.isArray(v) ? v : [];
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * POST /firms/{firmId}/import/backup (§8.7). Two phases: a full dry-run
 * validation/normalization pass (nothing written unless the whole payload is
 * structurally valid), then chunked commit passes in §9.5 dependency order.
 * Legacy int enums are mapped per §11.2; empty/missing firmIds scope to the
 * import target; stock-day and route natural keys are re-keyed (§9.6).
 */
export async function importBackup(
  firmId: string,
  userId: string,
  body: any,
  mode: 'replace' | 'merge',
): Promise<ImportResult> {
  if (!body || typeof body !== 'object') throw errors.validation('Backup body must be a JSON object');
  const version = Number(body.schemaVersion ?? 0);
  if (![1, 2, 3].includes(version)) {
    throw errors.validation('Unsupported schemaVersion', [
      { field: 'schemaVersion', code: 'UNSUPPORTED', message: 'schemaVersion must be 1, 2 or 3' },
    ]);
  }

  // In merge mode, masters already in the DB are valid references too.
  const dbSets =
    mode === 'merge' ? await existingMasterIds(firmId) : { parties: new Set<string>(), locations: new Set<string>(), grades: new Set<string>(), companies: new Set<string>(), sources: new Set<string>() };

  const plan = buildPlan(firmId, body, dbSets);
  if (plan.errors.length) {
    const first = plan.errors.slice(0, 50);
    throw errors.validation(
      `Backup validation failed (${plan.errors.length} problem(s); showing ${first.length}) — nothing was written`,
      first,
    );
  }

  // Commit passes — chunked to stay well under TiDB's transaction size cap.
  const p = plan.parsed!;
  const counts: Record<string, number> = {};
  if (mode === 'replace') {
    await tx(async (c) => {
      for (const t of [
        'parties', 'locations', 'grades', 'party_routes', 'freight_entries', 'opening_baselines',
        'stock_days', 'companies', 'sources', 'purchases', 'scheme_folders', 'schemes', 'claims',
      ]) {
        await c.query(`UPDATE ${t} SET deleted_at = UTC_TIMESTAMP(3), updated_by = ?, rev = rev + 1 WHERE firm_id = ? AND deleted_at IS NULL`, [userId, firmId]);
      }
    });
  }

  const write = async (label: string, rows: unknown[][], fn: (c: Q, r: unknown[]) => Promise<void>) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      await tx(async (c) => {
        for (const r of slice) await fn(c, r);
      });
      counts[label] = (counts[label] ?? 0) + slice.length;
    }
  };

  // Every table this is called with is keyed (firm_id, id), which is what
  // lets one conflict target serve all of them. SQLite needs it spelled out —
  // unlike MySQL's ON DUPLICATE KEY, which fired on whichever unique index
  // happened to be hit.
  const upsertSync = async (c: Q, table: string, cols: string[], vals: unknown[]) => {
    const setters = cols
      .filter((col) => col !== 'firm_id' && col !== 'id')
      .map((col) => `${col} = excluded.${col}`)
      .join(', ');
    await c.query(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})
       ON CONFLICT (firm_id, id) DO UPDATE SET
         ${setters}, deleted_at = NULL, rev = rev + 1`,
      vals,
    );
  };

  await write('grades', p.grades, (c, r: any) =>
    upsertSync(c, 'grades', ['firm_id', 'id', 'name', 'sort_order', 'bag_weight_kg', 'updated_by'], [firmId, r.id, r.name, r.order, r.bagWeightKg, userId]));
  await write('parties', p.parties, (c, r: any) =>
    upsertSync(c, 'parties', ['firm_id', 'id', 'code', 'name', 'phone', 'sort_order', 'updated_by'], [firmId, r.id, r.code, r.name, r.phone, r.order, userId]));
  await write('locations', p.locations, (c, r: any) =>
    upsertSync(c, 'locations', ['firm_id', 'id', 'name', 'updated_by'], [firmId, r.id, r.name, userId]));
  await write('companies', p.companies, (c, r: any) =>
    upsertSync(c, 'companies', ['firm_id', 'id', 'name', 'sort_order', 'updated_by'], [firmId, r.id, r.name, r.order, userId]));
  await write('sources', p.sources, (c, r: any) =>
    upsertSync(c, 'sources', ['firm_id', 'id', 'name', 'type', 'sort_order', 'updated_by'], [firmId, r.id, r.name, r.type, r.order, userId]));

  await write('routes', p.routes, async (c, r: any) => {
    const [rows] = await c.query('SELECT id FROM party_routes WHERE firm_id = ? AND party_id = ? AND location_id = ?', [firmId, r.partyId, r.locationId]);
    const existing = (rows as any[])[0];
    if (existing) {
      await c.query('UPDATE party_routes SET distance_km=?, revenue_per_bag=?, deleted_at=NULL, rev=rev+1, updated_by=? WHERE firm_id=? AND id=?', [r.distanceKm, r.revenuePerBag, userId, firmId, existing.id]);
    } else {
      await c.query('INSERT INTO party_routes (firm_id, id, party_id, location_id, distance_km, revenue_per_bag, updated_by) VALUES (?,?,?,?,?,?,?)', [firmId, newId(), r.partyId, r.locationId, r.distanceKm, r.revenuePerBag, userId]);
    }
  });

  if (p.baseline) {
    const b = p.baseline;
    await tx(async (c) => {
      await c.query(
        `INSERT INTO opening_baselines (firm_id, date, updated_by) VALUES (?,?,?)
         ON CONFLICT (firm_id) DO UPDATE SET
           date = excluded.date, deleted_at = NULL, rev = rev + 1,
           updated_by = excluded.updated_by`,
        [firmId, b.date, userId],
      );
      await c.query('DELETE FROM opening_baseline_stock WHERE firm_id = ?', [firmId]);
      await c.query('DELETE FROM opening_baseline_party WHERE firm_id = ?', [firmId]);
      const gradeIds = new Set([...Object.keys(b.physical), ...Object.keys(b.sap)]);
      for (const g of gradeIds) {
        await c.query('INSERT INTO opening_baseline_stock (firm_id, grade_id, physical, sap) VALUES (?,?,?,?)', [firmId, g, b.physical[g] ?? 0, b.sap[g] ?? 0]);
      }
      for (const [partyId, grades] of Object.entries(b.party)) {
        for (const [gradeId, xQty] of Object.entries(grades as Record<string, number>)) {
          await c.query('INSERT INTO opening_baseline_party (firm_id, party_id, grade_id, x_qty) VALUES (?,?,?,?)', [firmId, partyId, gradeId, num(xQty)]);
        }
      }
    });
    counts.baseline = 1;
  }

  await write('stockDays', p.stockDays, async (c, r: any) => {
    const [rows] = await c.query('SELECT id, deleted_at FROM stock_days WHERE firm_id = ? AND date = ?', [firmId, r.date]);
    const existing = (rows as any[])[0];
    let dayId: string;
    if (existing) {
      dayId = existing.id;
      await c.query('UPDATE stock_days SET deleted_at = NULL, rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ?', [userId, firmId, dayId]);
    } else {
      dayId = newId();
      await c.query('INSERT INTO stock_days (firm_id, id, date, updated_by) VALUES (?,?,?,?)', [firmId, dayId, r.date, userId]);
    }
    await c.query('UPDATE stock_days SET note = ? WHERE firm_id = ? AND id = ?', [r.note ?? '', firmId, dayId]);
    // Restore semantics: the sheet in the file IS the sheet (full replace of children).
    await c.query('DELETE FROM stock_receipts WHERE firm_id = ? AND stock_day_id = ?', [firmId, dayId]);
    await c.query('DELETE FROM stock_day_cells WHERE firm_id = ? AND stock_day_id = ?', [firmId, dayId]);
    for (const rc of r.receipts) {
      await c.query('INSERT INTO stock_receipts (firm_id, id, stock_day_id, grade_id, qty, sap_qty, ref) VALUES (?,?,?,?,?,?,?)', [firmId, rc.id, dayId, rc.gradeId, rc.qty, rc.sapQty, rc.ref]);
    }
    for (const [partyId, grades] of Object.entries(r.rows as Record<string, Record<string, { billing: number; dispatch: number }>>)) {
      for (const [gradeId, cell] of Object.entries(grades)) {
        if (num(cell.billing) === 0 && num(cell.dispatch) === 0) continue; // §6.6 sparsity
        await c.query('INSERT INTO stock_day_cells (firm_id, stock_day_id, party_id, grade_id, billing, dispatch) VALUES (?,?,?,?,?,?)', [firmId, dayId, partyId, gradeId, num(cell.billing), num(cell.dispatch)]);
      }
    }
  });

  await write('freightEntries', p.freightEntries, async (c, r: any) => {
    await c.query(
      `INSERT INTO freight_entries (firm_id, id, serial, date, party_id, location_id, vehicle_no, revenue_per_bag, bags,
         total_reimbursed, basis, cost_rate, cost_units, other_expenses, other_note, total_cost, profit, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (firm_id, id) DO UPDATE SET
         date=excluded.date, party_id=excluded.party_id, location_id=excluded.location_id,
         vehicle_no=excluded.vehicle_no, revenue_per_bag=excluded.revenue_per_bag, bags=excluded.bags,
         total_reimbursed=excluded.total_reimbursed, basis=excluded.basis, cost_rate=excluded.cost_rate,
         cost_units=excluded.cost_units, other_expenses=excluded.other_expenses, other_note=excluded.other_note,
         total_cost=excluded.total_cost, profit=excluded.profit, deleted_at=NULL, rev=rev+1,
         updated_by=excluded.updated_by`,
      [firmId, r.id, r.serial, r.date, r.partyId, r.locationId, r.vehicleNo, r.revenuePerBag, r.bags, r.totalReimbursed,
       r.basis, r.costRate, r.costUnits, r.otherExpenses, r.otherNote, r.totalCost, r.profit, userId],
    );
    await c.query('DELETE FROM freight_entry_grades WHERE firm_id = ? AND entry_id = ?', [firmId, r.id]);
    for (const [g, b] of Object.entries(r.gradeBags as Record<string, number>)) {
      await c.query('INSERT INTO freight_entry_grades (firm_id, entry_id, grade_id, bags) VALUES (?,?,?,?)', [firmId, r.id, g, b]);
    }
  });

  // Folders before the schemes that point at them — schemes.folder_id is a
  // real FK, so a scheme written first would be rejected outright.
  await write('schemeFolders', p.schemeFolders, (c, r: any) =>
    upsertSync(c, 'scheme_folders', ['firm_id', 'id', 'name', 'sort_order', 'updated_by'], [firmId, r.id, r.name, r.order, userId]));

  await write('schemes', p.schemes, async (c, r: any) => {
    await upsertSync(c, 'schemes',
      ['firm_id', 'id', 'name', 'company_id', 'folder_id', 'grade_id', 'per_grade', 'source_id', 'kind', 'period', 'window_from', 'window_to', 'qty_unit', 'value_type', 'min_premium_qty', 'min_premium_unit', 'active', 'updated_by'],
      [firmId, r.id, r.name, r.companyId, r.folderId, r.gradeId, r.perGrade ? 1 : 0, r.sourceId, r.kind, r.period, r.windowFrom, r.windowTo, r.qtyUnit, r.valueType, r.minPremiumQty, r.minPremiumUnit, r.active ? 1 : 0, userId]);
    await c.query('DELETE FROM scheme_slabs WHERE firm_id = ? AND scheme_id = ?', [firmId, r.id]);
    await c.query('DELETE FROM scheme_premium_grades WHERE firm_id = ? AND scheme_id = ?', [firmId, r.id]);
    await c.query('DELETE FROM scheme_grades WHERE firm_id = ? AND scheme_id = ?', [firmId, r.id]);
    for (const s of r.slabs) {
      await c.query('INSERT INTO scheme_slabs (firm_id, scheme_id, slab_from, slab_value) VALUES (?,?,?,?)', [firmId, r.id, s.from, s.value]);
    }
    for (const g of r.premiumGradeIds) {
      await c.query('INSERT INTO scheme_premium_grades (firm_id, scheme_id, grade_id) VALUES (?,?,?)', [firmId, r.id, g]);
    }
    for (const g of r.gradeIds) {
      await c.query('INSERT INTO scheme_grades (firm_id, scheme_id, grade_id) VALUES (?,?,?)', [firmId, r.id, g]);
    }
  });

  await write('purchases', p.purchases, async (c, r: any) => {
    await upsertSync(c, 'purchases',
      ['firm_id', 'id', 'date', 'company_id', 'grade_id', 'source_id', 'qty', 'rate_per_bag', 'invoice_no', 'updated_by'],
      [firmId, r.id, r.date, r.companyId, r.gradeId, r.sourceId, r.qty, r.ratePerBag, r.invoiceNo, userId]);
    for (const pm of r.payments) {
      await c.query(
        `INSERT INTO purchase_payments (firm_id, id, purchase_id, date, amount) VALUES (?,?,?,?,?)
         ON CONFLICT (firm_id, id) DO UPDATE SET date = excluded.date, amount = excluded.amount`,
        [firmId, pm.id, r.id, pm.date, pm.amount],
      );
    }
  });

  await write('claims', p.claims, async (c, r: any) => {
    try {
      await upsertSync(c, 'claims',
        ['firm_id', 'id', 'scheme_id', 'company_id', 'scheme_name', 'period_from', 'period_to', 'label', 'bags', 'accrued', 'status', 'sent_on', 'updated_by'],
        [firmId, r.id, r.schemeId, r.companyId, r.schemeName, r.periodFrom, r.periodTo, r.label, r.bags, r.accrued, r.status, r.sentOn, userId]);
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      // uk_claim_period collision under a different id: prefer the row being imported.
      await c.query('DELETE FROM claims WHERE firm_id = ? AND scheme_id = ? AND period_from = ? AND id <> ?', [firmId, r.schemeId, r.periodFrom, r.id]);
      await upsertSync(c, 'claims',
        ['firm_id', 'id', 'scheme_id', 'company_id', 'scheme_name', 'period_from', 'period_to', 'label', 'bags', 'accrued', 'status', 'sent_on', 'updated_by'],
        [firmId, r.id, r.schemeId, r.companyId, r.schemeName, r.periodFrom, r.periodTo, r.label, r.bags, r.accrued, r.status, r.sentOn, userId]);
    }
    for (const n of r.creditNotes) {
      await c.query(
        `INSERT INTO claim_credit_notes (firm_id, id, claim_id, date, number, amount) VALUES (?,?,?,?,?,?)
         ON CONFLICT (firm_id, id) DO UPDATE SET
         date = excluded.date, number = excluded.number, amount = excluded.amount`,
        [firmId, n.id, r.id, n.date, n.number, n.amount],
      );
    }
  });

  // §5.1: keep the counter ahead of restored data (ensureSerialAtLeast).
  const maxSerial = p.freightEntries.reduce((a: number, r: any) => Math.max(a, Number(r.serial) || 0), 0);
  await tx(async (c) => {
    await ensureSerialAtLeast(c, firmId, maxSerial);
  });

  return { imported: counts, warnings: plan.warnings };
}

// ------------------------------------------------------------------ dry-run parse

export async function existingMasterIds(firmId: string): Promise<{
  parties: Set<string>; locations: Set<string>; grades: Set<string>; companies: Set<string>; sources: Set<string>;
}> {
  const { q } = await import('../../db/pool');
  const get = async (t: string) =>
    new Set<string>((await q<{ id: string }>(`SELECT id FROM ${t} WHERE firm_id = ? AND deleted_at IS NULL`, [firmId])).map((r) => r.id));
  const [parties, locations, grades, companies, sources] = await Promise.all(
    ['parties', 'locations', 'grades', 'companies', 'sources'].map(get),
  );
  return { parties, locations, grades, companies, sources };
}

type RefSets = { parties: Set<string>; locations: Set<string>; grades: Set<string>; companies: Set<string>; sources: Set<string> };

function buildPlan(firmId: string, body: any, dbSets?: RefSets): Plan & { parsed?: any } {
  const errorsL: ErrorDetail[] = [];
  const warnings: string[] = [];
  const err = (entity: string, i: number, field: string, message: string) =>
    errorsL.push({ field: `${entity}[${i}].${field}`, code: 'INVALID', message });

  const idSet = (rows: any[]) => new Set(rows.map((r) => r.id));

  const parties = arr(body, 'parties').map((r, i) => {
    if (!isUuid(r?.id)) err('parties', i, 'id', 'id must be a UUID');
    if (typeof r?.name !== 'string' || !r.name.trim()) err('parties', i, 'name', 'name is required');
    return { id: String(r?.id), code: r?.code ?? null, name: String(r?.name ?? ''), phone: r?.phone ?? null, order: num(r?.order) };
  }).filter((r) => isUuid(r.id));

  const locations = arr(body, 'locations').map((r, i) => {
    if (!isUuid(r?.id)) err('locations', i, 'id', 'id must be a UUID');
    if (typeof r?.name !== 'string' || !r.name.trim()) err('locations', i, 'name', 'name is required');
    return { id: String(r?.id), name: String(r?.name ?? '') };
  }).filter((r) => isUuid(r.id));

  const grades = arr(body, 'grades').map((r, i) => {
    if (!isUuid(r?.id)) err('grades', i, 'id', 'id must be a UUID');
    if (typeof r?.name !== 'string' || !r.name.trim()) err('grades', i, 'name', 'name is required');
    return { id: String(r?.id), name: String(r?.name ?? ''), order: num(r?.order), bagWeightKg: isFiniteNumber(r?.bagWeightKg) && r.bagWeightKg > 0 ? r.bagWeightKg : 50 };
  }).filter((r) => isUuid(r.id));

  const companies = arr(body, 'companies').map((r, i) => {
    if (!isUuid(r?.id)) err('companies', i, 'id', 'id must be a UUID');
    if (typeof r?.name !== 'string' || !r.name.trim()) err('companies', i, 'name', 'name is required');
    return { id: String(r?.id), name: String(r?.name ?? ''), order: num(r?.order) };
  }).filter((r) => isUuid(r.id));

  const sources = arr(body, 'sources').map((r, i) => {
    if (!isUuid(r?.id)) err('sources', i, 'id', 'id must be a UUID');
    if (typeof r?.name !== 'string' || !r.name.trim()) err('sources', i, 'name', 'name is required');
    const type = enumFromLegacy<'plant' | 'depot'>('SourceType', r?.type, 'plant' as const);
    if (r?.type !== undefined && r?.type !== null && !type) err('sources', i, 'type', 'unknown source type');
    return { id: String(r?.id), name: String(r?.name ?? ''), type: type ?? 'plant', order: num(r?.order) };
  }).filter((r) => isUuid(r.id));

  const schemeFolders = arr(body, 'schemeFolders').map((r, i) => {
    if (!isUuid(r?.id)) err('schemeFolders', i, 'id', 'id must be a UUID');
    if (typeof r?.name !== 'string' || !r.name.trim()) err('schemeFolders', i, 'name', 'name is required');
    return { id: String(r?.id), name: String(r?.name ?? ''), order: num(r?.order) };
  }).filter((r) => isUuid(r.id));

  const mergeSet = (a: Set<string>, b?: Set<string>) => {
    const out = new Set(a);
    b?.forEach((x) => out.add(x));
    return out;
  };
  const partyIds = mergeSet(idSet(parties), dbSets?.parties);
  const locationIds = mergeSet(idSet(locations), dbSets?.locations);
  const gradeIds = mergeSet(idSet(grades), dbSets?.grades);
  const companyIds = mergeSet(idSet(companies), dbSets?.companies);
  const sourceIds = mergeSet(idSet(sources), dbSets?.sources);
  const folderIds = idSet(schemeFolders);

  const routes = arr(body, 'routes').flatMap((r, i) => {
    let partyId = r?.partyId; let locationId = r?.locationId;
    if ((!partyId || !locationId) && typeof r?.key === 'string' && r.key.includes('::')) [partyId, locationId] = r.key.split('::');
    if (!isUuid(partyId) || !isUuid(locationId)) { err('routes', i, 'key', 'route needs partyId+locationId'); return []; }
    if (!partyIds.has(partyId)) err('routes', i, 'partyId', 'unknown party');
    if (!locationIds.has(locationId)) err('routes', i, 'locationId', 'unknown location');
    return [{ partyId, locationId, distanceKm: num(r?.distanceKm), revenuePerBag: num(r?.revenuePerBag) }];
  });

  // baseline
  let baseline: any = null;
  const rawBaseline = body.baseline ?? body.openingBaseline ?? null;
  if (rawBaseline) {
    const date = parseBusinessDate(rawBaseline.date);
    if (!date) {
      err('baseline', 0, 'date', 'invalid date');
    } else {
      const cleanMap = (m: any, keyHint: string, gradeCheck: boolean) => {
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(m ?? {})) {
          if (!isUuid(k)) { warnings.push(`baseline.${keyHint}: dropping non-UUID key '${k}'`); continue; }
          if (gradeCheck && !gradeIds.has(k)) { warnings.push(`baseline.${keyHint}: unknown grade '${k}' kept anyway`); }
          out[k] = num(v);
        }
        return out;
      };
      const partyOut: Record<string, Record<string, number>> = {};
      for (const [pid, gmap] of Object.entries(rawBaseline.party ?? {})) {
        if (!isUuid(pid) || !partyIds.has(pid)) { err('baseline', 0, 'party', `unknown party '${pid}'`); continue; }
        partyOut[pid] = cleanMap(gmap, `party.${pid}`, true);
      }
      baseline = { date, physical: cleanMap(rawBaseline.physical, 'physical', true), sap: cleanMap(rawBaseline.sap, 'sap', true), party: partyOut };
    }
  }

  const stockDays = arr(body, 'stockDays').flatMap((r, i) => {
    // client id shape: "{firmId}|yyyy-MM-dd" (§1.2)
    let date = parseBusinessDate(r?.date);
    if (!date && typeof r?.id === 'string' && r.id.includes('|')) date = parseBusinessDate(r.id.split('|')[1]);
    if (!date) { err('stockDays', i, 'date', 'invalid date'); return []; }
    if (baseline && date <= baseline.date) err('stockDays', i, 'date', 'stock day must be strictly after the baseline date');
    const receipts = (Array.isArray(r?.receipts) ? r.receipts : []).flatMap((rc: any, j: number) => {
      if (!isUuid(rc?.id) || !isUuid(rc?.gradeId)) { err('stockDays', i, `receipts[${j}]`, 'receipt needs id + gradeId'); return []; }
      if (!gradeIds.has(rc.gradeId)) { err('stockDays', i, `receipts[${j}].gradeId`, `unknown grade '${rc.gradeId}'`); return []; }
      return [{ id: rc.id, gradeId: rc.gradeId, qty: num(rc.qty), sapQty: num(rc.sapQty), ref: String(rc.ref ?? '').slice(0, 120) }];
    });
    const rowsMap: Record<string, Record<string, { billing: number; dispatch: number }>> = {};
    for (const [pid, gmap] of Object.entries(r?.rows ?? {})) {
      if (!isUuid(pid) || !partyIds.has(pid)) { err('stockDays', i, 'rows', `unknown party '${pid}'`); continue; }
      for (const [gid, cell] of Object.entries(gmap as any)) {
        if (!isUuid(gid) || !gradeIds.has(gid)) { err('stockDays', i, `rows.${pid}`, `unknown grade '${gid}'`); continue; }
        const billing = num((cell as any).billing); const dispatch = num((cell as any).dispatch);
        if (billing === 0 && dispatch === 0) continue;
        (rowsMap[pid] ??= {})[gid] = { billing, dispatch };
      }
    }
    return [{ date, note: String(r?.note ?? '').slice(0, 500), receipts, rows: rowsMap }];
  });

  const seenDayDates = new Set<string>();
  for (const [i, dy] of stockDays.entries()) {
    if (seenDayDates.has(dy.date)) err('stockDays', i, 'date', 'duplicate day in backup');
    seenDayDates.add(dy.date);
  }

  const freightEntries = arr(body, 'freightEntries').flatMap((r, i) => {
    if (!isUuid(r?.id)) { err('freightEntries', i, 'id', 'id must be a UUID'); return []; }
    const date = parseBusinessDate(r?.date);
    if (!date) { err('freightEntries', i, 'date', 'invalid date'); return []; }
    if (!isUuid(r?.partyId) || !partyIds.has(r.partyId)) { err('freightEntries', i, 'partyId', 'unknown party'); return []; }
    if (!isUuid(r?.locationId) || !locationIds.has(r.locationId)) { err('freightEntries', i, 'locationId', 'unknown location'); return []; }
    const basis = enumFromLegacy<'km' | 'bag'>('CostBasis', r?.basis, 'km' as const) ?? 'km';
    const serial = Math.trunc(num(r?.serial));
    if (serial < 0) err('freightEntries', i, 'serial', 'serial must be >= 0');
    const units = basis === 'bag' ? num(r?.bags) : num(r?.costUnits);
    const tr = num(r?.totalReimbursed); const tc = num(r?.totalCost); const prof = num(r?.profit);
    if (Math.abs(tr - num(r?.revenuePerBag) * num(r?.bags)) > 0.01 || Math.abs(tc - (num(r?.costRate) * units + num(r?.otherExpenses))) > 0.01 || Math.abs(prof - (tr - tc)) > 0.01) {
      warnings.push(`freightEntries[${i}]: stored totals mismatch formula (kept as-is, client will show them)`);
    }
    const gradeBags: Record<string, number> = {};
    for (const [gid, b] of Object.entries(r?.gradeBags ?? {})) {
      if (!isUuid(gid)) { warnings.push(`freightEntries[${i}].gradeBags: dropping non-UUID grade '${gid}'`); continue; }
      gradeBags[gid] = num(b);
    }
    return [{
      id: r.id, serial, date, partyId: r.partyId, locationId: r.locationId,
      vehicleNo: String(r?.vehicleNo ?? '').toUpperCase().slice(0, 32),
      revenuePerBag: num(r?.revenuePerBag), bags: num(r?.bags), totalReimbursed: tr,
      basis, costRate: num(r?.costRate), costUnits: num(r?.costUnits), otherExpenses: num(r?.otherExpenses),
      otherNote: String(r?.otherNote ?? '').slice(0, 500), totalCost: tc, profit: prof, gradeBags,
    }];
  });
  const seenSerials = new Map<number, number>();
  freightEntries.forEach((e, i) => {
    if (e.serial > 0) {
      if (seenSerials.has(e.serial)) err('freightEntries', i, 'serial', `serial ${e.serial} appears twice in backup`);
      seenSerials.set(e.serial, i);
    }
  });

  const schemes = arr(body, 'schemes').flatMap((r, i) => {
    if (!isUuid(r?.id)) { err('schemes', i, 'id', 'id must be a UUID'); return []; }
    if (typeof r?.name !== 'string' || !r.name.trim()) { err('schemes', i, 'name', 'name is required'); return []; }
    if (!isUuid(r?.companyId) || !companyIds.has(r.companyId)) { err('schemes', i, 'companyId', 'unknown company'); return []; }
    // Grade scope: `gradeIds` when the file has it, else the pre-multi-grade
    // single `gradeId` (whose null meant "all grades" — the empty set).
    const rawGradeIds: string[] = Array.isArray(r?.gradeIds)
      ? r.gradeIds
      : (r?.gradeId != null ? [r.gradeId] : []);
    const schemeGradeIds = Array.from(new Set(rawGradeIds.map((g: any) => String(g)))).filter((g) => {
      const ok = isUuid(g) && gradeIds.has(g);
      if (!ok) warnings.push(`schemes[${i}].gradeIds: unknown grade '${g}' dropped`);
      return ok;
    });
    // Dropping every named grade would silently widen the scheme from "these
    // two grades" to "all grades" — a bigger claim than the letter allows.
    if (rawGradeIds.length > 0 && schemeGradeIds.length === 0) {
      err('schemes', i, 'gradeIds', 'every named grade is unknown; the scheme would widen to all grades');
    }
    if (r?.folderId != null && !folderIds.has(r.folderId)) {
      warnings.push(`schemes[${i}].folderId: unknown folder '${r.folderId}' — imported unfiled`);
    }
    if (r?.sourceId != null && !sourceIds.has(r.sourceId)) err('schemes', i, 'sourceId', 'unknown source');
    const kind = enumFromLegacy<'fixed' | 'variable' | 'mix' | 'cash'>('SchemeKind', r?.kind, 'fixed' as const) ?? 'fixed';
    const period = enumFromLegacy<'monthly' | 'quarterly' | 'annual'>('SchemePeriod', r?.period ?? null);
    const windowFrom = r?.windowFrom != null ? parseBusinessDate(r.windowFrom) : null;
    const windowTo = r?.windowTo != null ? parseBusinessDate(r.windowTo) : null;
    if (r?.windowFrom != null && !windowFrom) err('schemes', i, 'windowFrom', 'invalid date');
    if (r?.windowTo != null && !windowTo) err('schemes', i, 'windowTo', 'invalid date');
    if (kind === 'variable' && (!windowFrom || !windowTo)) err('schemes', i, 'windowFrom', 'variable schemes need windowFrom/windowTo');
    if ((kind === 'fixed' || kind === 'mix') && !period) err('schemes', i, 'period', `${kind} schemes need a period`);
    const slabs = (Array.isArray(r?.slabs) ? r.slabs : [])
      .map((s: any) => ({ from: num(s?.from), value: num(s?.value) }))
      .sort((a: any, b: any) => a.from - b.from);
    const froms = new Set(slabs.map((s: any) => s.from));
    if (froms.size !== slabs.length) err('schemes', i, 'slabs', 'duplicate slab "from"');
    const premiumGradeIds = (Array.isArray(r?.premiumGradeIds) ? r.premiumGradeIds : []).filter((g: any) => {
      const ok = isUuid(g) && gradeIds.has(g);
      if (!ok && isUuid(g)) warnings.push(`schemes[${i}].premiumGradeIds: unknown grade '${g}' dropped`);
      return ok;
    });
    if (kind === 'mix' && premiumGradeIds.length === 0) err('schemes', i, 'premiumGradeIds', 'mix schemes need premium grades');
    return [{
      id: r.id, name: String(r.name), companyId: r.companyId,
      gradeIds: schemeGradeIds,
      gradeId: schemeGradeIds.length === 1 ? schemeGradeIds[0] : null,
      folderId: r?.folderId != null && folderIds.has(r.folderId) ? r.folderId : null,
      perGrade: !!r?.perGrade, sourceId: r?.sourceId ?? null,
      kind, period, windowFrom, windowTo,
      qtyUnit: enumFromLegacy<'bag' | 'mt'>('QtyUnit', r?.qtyUnit, 'bag' as const) ?? 'bag',
      valueType: enumFromLegacy<'perBag' | 'perMt' | 'percent'>('ValueType', r?.valueType, 'perBag' as const) ?? 'perBag',
      premiumGradeIds, minPremiumQty: num(r?.minPremiumQty),
      // §11.2 trap: the client default is index 1 = 'mt'.
      minPremiumUnit: enumFromLegacy<'bag' | 'mt'>('QtyUnit', r?.minPremiumUnit ?? 1, 'mt' as const) ?? 'mt',
      slabs, active: r?.active !== false,
    }];
  });
  const schemeIds = idSet(schemes);

  const purchases = arr(body, 'purchases').flatMap((r, i) => {
    if (!isUuid(r?.id)) { err('purchases', i, 'id', 'id must be a UUID'); return []; }
    const date = parseBusinessDate(r?.date);
    if (!date) { err('purchases', i, 'date', 'invalid date'); return []; }
    if (!companyIds.has(r?.companyId)) { err('purchases', i, 'companyId', 'unknown company'); return []; }
    if (!gradeIds.has(r?.gradeId)) { err('purchases', i, 'gradeId', 'unknown grade'); return []; }
    if (!sourceIds.has(r?.sourceId)) { err('purchases', i, 'sourceId', 'unknown source'); return []; }
    const qty = num(r?.qty); const ratePerBag = num(r?.ratePerBag);
    if (!(qty > 0)) err('purchases', i, 'qty', 'qty must be > 0');
    if (!(ratePerBag >= 0)) err('purchases', i, 'ratePerBag', 'ratePerBag must be >= 0');
    const payments = (Array.isArray(r?.payments) ? r.payments : []).flatMap((pm: any, j: number) => {
      const pd = parseBusinessDate(pm?.date);
      if (!pd || !isFiniteNumber(pm?.amount)) { err('purchases', i, `payments[${j}]`, 'payment needs date + amount'); return []; }
      return [{ id: isUuid(pm.id) ? pm.id : newId(), date: pd, amount: num(pm.amount) }];
    });
    return [{ id: r.id, date, companyId: r.companyId, gradeId: r.gradeId, sourceId: r.sourceId, qty, ratePerBag, invoiceNo: String(r?.invoiceNo ?? '').slice(0, 80), payments }];
  });

  const claims = arr(body, 'claims').flatMap((r, i) => {
    if (!isUuid(r?.id)) { err('claims', i, 'id', 'id must be a UUID'); return []; }
    const periodFrom = parseBusinessDate(r?.periodFrom);
    const periodTo = parseBusinessDate(r?.periodTo);
    if (!periodFrom || !periodTo) { err('claims', i, 'periodFrom', 'invalid period'); return []; }
    if (periodFrom > periodTo) err('claims', i, 'periodFrom', 'periodFrom must be <= periodTo');
    const accrued = num(r?.accrued);
    if (accrued < 0) err('claims', i, 'accrued', 'accrued must be >= 0');
    const schemeId = isUuid(r?.schemeId) ? r.schemeId : null;
    if (!schemeId) { err('claims', i, 'schemeId', 'schemeId must be a UUID'); return []; }
    if (!schemeIds.has(schemeId)) warnings.push(`claims[${i}]: scheme '${schemeId}' not in backup (kept — claims survive scheme deletion by design)`);
    const companyId = isUuid(r?.companyId) ? r.companyId : null;
    if (!companyId) { err('claims', i, 'companyId', 'companyId must be a UUID'); return []; }
    const status = enumFromLegacy<'claimable' | 'claimed' | 'received'>('ClaimStatus', r?.status, 'claimable' as const) ?? 'claimable';
    if (kindOf(schemes, schemeId) === 'cash') warnings.push(`claims[${i}]: cash schemes never produce claims — imported anyway (frozen snapshot)`);
    const creditNotes = (Array.isArray(r?.creditNotes) ? r.creditNotes : []).flatMap((n: any, j: number) => {
      const nd = parseBusinessDate(n?.date);
      if (!nd || !isFiniteNumber(n?.amount)) { err('claims', i, `creditNotes[${j}]`, 'credit note needs date + amount'); return []; }
      return [{ id: isUuid(n.id) ? n.id : newId(), date: nd, number: String(n?.number ?? '').slice(0, 80), amount: num(n.amount) }];
    });
    return [{
      id: r.id, schemeId, companyId, schemeName: String(r?.schemeName ?? '').slice(0, 200),
      periodFrom, periodTo, label: String(r?.label ?? '').slice(0, 60),
      bags: num(r?.bags), accrued, status,
      sentOn: r?.sentOn ? parseBusinessDate(r.sentOn) : null,
      creditNotes,
    }];
  });

  if (errorsL.length) return { errors: errorsL, warnings };
  return {
    errors: [], warnings,
    parsed: { parties, locations, grades, companies, sources, routes, baseline, stockDays, freightEntries, schemeFolders, schemes, purchases, claims },
  };
}

function kindOf(schemes: any[], id: string): string | null {
  return schemes.find((s) => s.id === id)?.kind ?? null;
}
