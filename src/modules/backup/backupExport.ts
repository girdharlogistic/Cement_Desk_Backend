import { q, qOne } from '../../db/pool';
import { enumToLegacy } from './enumMaps';
import { num } from '../../lib/num';

/**
 * GET /firms/{firmId}/export/backup — produces the v3 JSON shape the client's
 * `restoreFromJson` consumes (§8.7). Enums are written as legacy indexes (§11.2);
 * stock days and routes carry their client natural keys.
 */
export async function exportBackup(firmId: string): Promise<any> {
  const firm = await qOne<any>('SELECT * FROM firms WHERE id = ?', [firmId]);
  if (!firm) return null;

  const grab = <T = any>(sql: string, params: unknown[]) => q<T>(sql, params);

  const parties = await grab<any>('SELECT * FROM parties WHERE firm_id = ? ORDER BY sort_order', [firmId]);
  const locations = await grab<any>('SELECT * FROM locations WHERE firm_id = ?', [firmId]);
  const grades = await grab<any>('SELECT * FROM grades WHERE firm_id = ? ORDER BY sort_order', [firmId]);
  const routes = await grab<any>('SELECT * FROM party_routes WHERE firm_id = ?', [firmId]);
  const entries = await grab<any>('SELECT * FROM freight_entries WHERE firm_id = ? ORDER BY date', [firmId]);
  const egb = await grab<any>('SELECT * FROM freight_entry_grades WHERE firm_id = ?', [firmId]);
  const baselineRows = await grab<any>('SELECT * FROM opening_baselines WHERE firm_id = ?', [firmId]);
  const blStock = await grab<any>('SELECT * FROM opening_baseline_stock WHERE firm_id = ?', [firmId]);
  const blParty = await grab<any>('SELECT * FROM opening_baseline_party WHERE firm_id = ?', [firmId]);
  const days = await grab<any>('SELECT * FROM stock_days WHERE firm_id = ? ORDER BY date', [firmId]);
  const receipts = await grab<any>('SELECT * FROM stock_receipts WHERE firm_id = ?', [firmId]);
  const cells = await grab<any>('SELECT * FROM stock_day_cells WHERE firm_id = ?', [firmId]);
  const companies = await grab<any>('SELECT * FROM companies WHERE firm_id = ? ORDER BY sort_order', [firmId]);
  const sources = await grab<any>('SELECT * FROM sources WHERE firm_id = ? ORDER BY sort_order', [firmId]);
  const purchases = await grab<any>('SELECT * FROM purchases WHERE firm_id = ? ORDER BY date', [firmId]);
  const payments = await grab<any>('SELECT * FROM purchase_payments WHERE firm_id = ? ORDER BY date', [firmId]);
  const schemes = await grab<any>('SELECT * FROM schemes WHERE firm_id = ?', [firmId]);
  const slabs = await grab<any>('SELECT * FROM scheme_slabs WHERE firm_id = ? ORDER BY slab_from', [firmId]);
  const premium = await grab<any>('SELECT * FROM scheme_premium_grades WHERE firm_id = ?', [firmId]);
  const schemeGrades = await grab<any>('SELECT * FROM scheme_grades WHERE firm_id = ?', [firmId]);
  const folders = await grab<any>('SELECT * FROM scheme_folders WHERE firm_id = ? ORDER BY sort_order', [firmId]);
  const claims = await grab<any>('SELECT * FROM claims WHERE firm_id = ? ORDER BY period_from', [firmId]);
  const notes = await grab<any>('SELECT * FROM claim_credit_notes WHERE firm_id = ? ORDER BY date', [firmId]);
  const counter = await grab<any>('SELECT freight_serial FROM firm_counters WHERE firm_id = ?', [firmId]);

  const d = (r: any) => (r.deleted_at ? true : false);
  const live = (rows: any[]) => rows.filter((r) => !d(r));

  const gbByEntry = new Map<string, Record<string, number>>();
  for (const g of egb) {
    if (!gbByEntry.has(g.entry_id)) gbByEntry.set(g.entry_id, {});
    gbByEntry.get(g.entry_id)![g.grade_id] = num(g.bags);
  }

  const baselineRow = baselineRows[0];
  const baseline = baselineRow
    ? {
        firmId,
        date: baselineRow.date,
        physical: Object.fromEntries(blStock.map((s) => [s.grade_id, num(s.physical)])),
        sap: Object.fromEntries(blStock.map((s) => [s.grade_id, num(s.sap)])),
        party: blParty.reduce((acc: any, p) => {
          (acc[p.party_id] ??= {})[p.grade_id] = num(p.x_qty);
          return acc;
        }, {}),
      }
    : null;

  return {
    schemaVersion: 3,
    exportedAt: new Date().toISOString(),
    firms: [{ id: firm.id, name: firm.name }],
    meta: {
      fyStartMonth: Number(firm.fy_start_month),
      serialCounters: { [firmId]: Number(counter[0]?.freight_serial ?? 0) },
    },
    parties: live(parties).map((r) => ({ id: r.id, firmId, code: r.code, name: r.name, phone: r.phone, order: Number(r.sort_order) })),
    locations: live(locations).map((r) => ({ id: r.id, firmId, name: r.name })),
    grades: live(grades).map((r) => ({ id: r.id, firmId, name: r.name, order: Number(r.sort_order), bagWeightKg: num(r.bag_weight_kg) })),
    routes: live(routes).map((r) => ({
      key: `${r.party_id}::${r.location_id}`,
      firmId, partyId: r.party_id, locationId: r.location_id,
      distanceKm: num(r.distance_km), revenuePerBag: num(r.revenue_per_bag),
    })),
    freightEntries: live(entries).map((r) => ({
      id: r.id, firmId, serial: Number(r.serial), date: r.date, partyId: r.party_id, locationId: r.location_id,
      vehicleNo: r.vehicle_no, revenuePerBag: num(r.revenue_per_bag), bags: num(r.bags),
      totalReimbursed: num(r.total_reimbursed), basis: enumToLegacy('CostBasis', r.basis),
      costRate: num(r.cost_rate), costUnits: num(r.cost_units), otherExpenses: num(r.other_expenses),
      otherNote: r.other_note, totalCost: num(r.total_cost), profit: num(r.profit),
      gradeBags: gbByEntry.get(r.id) ?? {},
    })),
    baseline,
    stockDays: live(days).map((r) => ({
      id: `${firmId}|${r.date}`, // client natural key (§1.2)
      firmId, date: r.date, note: r.note ?? '',
      receipts: receipts.filter((x) => x.stock_day_id === r.id).map((x) => ({
        id: x.id, gradeId: x.grade_id, qty: num(x.qty), sapQty: num(x.sap_qty), ref: x.ref,
      })),
      rows: cells.filter((x) => x.stock_day_id === r.id).reduce((acc: any, x) => {
        ((acc[x.party_id] ??= {})[x.grade_id] = { billing: num(x.billing), dispatch: num(x.dispatch) });
        return acc;
      }, {}),
    })),
    companies: live(companies).map((r) => ({ id: r.id, firmId, name: r.name, order: Number(r.sort_order) })),
    sources: live(sources).map((r) => ({ id: r.id, firmId, name: r.name, type: enumToLegacy('SourceType', r.type), order: Number(r.sort_order) })),
    purchases: live(purchases).map((r) => ({
      id: r.id, firmId, date: r.date, companyId: r.company_id, gradeId: r.grade_id, sourceId: r.source_id,
      qty: num(r.qty), ratePerBag: num(r.rate_per_bag), invoiceNo: r.invoice_no,
      payments: payments.filter((p) => p.purchase_id === r.id).map((p) => ({ id: p.id, date: p.date, amount: num(p.amount) })),
    })),
    schemeFolders: live(folders).map((r) => ({ id: r.id, firmId, name: r.name, order: Number(r.sort_order) })),
    schemes: live(schemes).map((r) => ({
      id: r.id, firmId, name: r.name, companyId: r.company_id,
      gradeIds: schemeGrades.filter((g) => g.scheme_id === r.id).map((g) => g.grade_id),
      // Kept alongside `gradeIds` so a restore into an app build that predates
      // multi-grade schemes still lands the single-grade case correctly.
      gradeId: r.grade_id,
      folderId: r.folder_id ?? null,
      perGrade: !!r.per_grade, sourceId: r.source_id,
      kind: enumToLegacy('SchemeKind', r.kind), period: enumToLegacy('SchemePeriod', r.period),
      windowFrom: r.window_from, windowTo: r.window_to,
      qtyUnit: enumToLegacy('QtyUnit', r.qty_unit), valueType: enumToLegacy('ValueType', r.value_type),
      premiumGradeIds: premium.filter((p) => p.scheme_id === r.id).map((p) => p.grade_id),
      minPremiumQty: num(r.min_premium_qty), minPremiumUnit: enumToLegacy('QtyUnit', r.min_premium_unit),
      slabs: slabs.filter((s) => s.scheme_id === r.id).map((s) => ({ from: num(s.slab_from), value: num(s.slab_value) })),
      active: !!r.active,
    })),
    claims: live(claims).map((r) => ({
      id: r.id, firmId, schemeId: r.scheme_id, companyId: r.company_id, schemeName: r.scheme_name,
      periodFrom: r.period_from, periodTo: r.period_to, label: r.label,
      bags: num(r.bags), accrued: num(r.accrued), status: enumToLegacy('ClaimStatus', r.status),
      sentOn: r.sent_on,
      creditNotes: notes.filter((n) => n.claim_id === r.id).map((n) => ({ id: n.id, date: n.date, number: n.number, amount: num(n.amount) })),
    })),
  };
}
