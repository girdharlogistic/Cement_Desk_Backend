import { PoolConnection } from 'mysql2/promise';
import { getPool, q, qOne, tx } from '../../db/pool';
import { errors, isDuplicateKey } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { num } from '../../lib/num';
import { syncMeta } from '../../plugins/guards';
import { validateScheme, SchemeInput, sortSlabs } from '../../lib/validators';

export interface SchemeWrite extends SchemeInput {
  id?: string;
  name: string;
  companyId: string;
  /** Empty = every grade. `gradeId` is the derived legacy single-grade field. */
  gradeIds?: string[];
  gradeId?: string | null;
  folderId?: string | null;
  perGrade: boolean;
  sourceId?: string | null;
}

/**
 * The grade scope, normalised. Clients that predate multi-grade schemes send
 * only `gradeId`, and its null there means "all grades" — the empty set.
 */
export function normalizeGradeIds(d: { gradeIds?: unknown; gradeId?: unknown }): string[] {
  if (Array.isArray(d.gradeIds)) return Array.from(new Set(d.gradeIds.map((g) => String(g))));
  return typeof d.gradeId === 'string' && d.gradeId ? [d.gradeId] : [];
}

/** What goes in the legacy `schemes.grade_id` column: the single grade, or null. */
export function legacyGradeId(gradeIds: string[]): string | null {
  return gradeIds.length === 1 ? gradeIds[0] : null;
}

async function childrenFor(firmId: string, schemeIds: string[]): Promise<{ slabs: any[]; premium: any[]; gradeRows: any[] }> {
  if (!schemeIds.length) return { slabs: [], premium: [], gradeRows: [] };
  const ph = schemeIds.map(() => '?').join(',');
  const [slabs, premium, gradeRows] = await Promise.all([
    q<any>(`SELECT * FROM scheme_slabs WHERE firm_id = ? AND scheme_id IN (${ph}) ORDER BY slab_from ASC`, [firmId, ...schemeIds]),
    q<any>(`SELECT * FROM scheme_premium_grades WHERE firm_id = ? AND scheme_id IN (${ph})`, [firmId, ...schemeIds]),
    q<any>(`SELECT * FROM scheme_grades WHERE firm_id = ? AND scheme_id IN (${ph})`, [firmId, ...schemeIds]),
  ]);
  return { slabs, premium, gradeRows };
}

export function mapScheme(r: any, slabs: any[], premium: any[], gradeRows: any[] = []): any {
  const gradeIds = gradeRows.filter((g) => g.scheme_id === r.id).map((g) => g.grade_id);
  return {
    id: r.id,
    firmId: r.firm_id,
    name: r.name,
    companyId: r.company_id,
    gradeIds,
    // Still sent: an app build that predates multi-grade schemes reads this
    // and nothing else, and a null here is its "all grades".
    gradeId: legacyGradeId(gradeIds),
    folderId: r.folder_id ?? null,
    perGrade: !!r.per_grade,
    sourceId: r.source_id ?? null,
    kind: r.kind,
    period: r.period ?? null,
    windowFrom: r.window_from ?? null,
    windowTo: r.window_to ?? null,
    qtyUnit: r.qty_unit,
    valueType: r.value_type,
    premiumGradeIds: premium.filter((p) => p.scheme_id === r.id).map((p) => p.grade_id),
    minPremiumQty: num(r.min_premium_qty),
    minPremiumUnit: r.min_premium_unit,
    slabs: slabs
      .filter((s) => s.scheme_id === r.id)
      .sort((a, b) => num(a.slab_from) - num(b.slab_from))
      .map((s) => ({ from: num(s.slab_from), value: num(s.slab_value) })),
    active: !!r.active,
    ...syncMeta(r),
  };
}

export async function fetchScheme(firmId: string, id: string): Promise<any | null> {
  const r = await qOne<any>('SELECT * FROM schemes WHERE firm_id = ? AND id = ?', [firmId, id]);
  if (!r) return null;
  const { slabs, premium, gradeRows } = await childrenFor(firmId, [id]);
  return mapScheme(r, slabs, premium, gradeRows);
}

export async function listSchemes(firmId: string, companyId?: string, active?: boolean): Promise<any[]> {
  const clauses = ['firm_id = ?', 'deleted_at IS NULL'];
  const params: unknown[] = [firmId];
  if (companyId) { clauses.push('company_id = ?'); params.push(companyId); }
  if (active !== undefined) { clauses.push('active = ?'); params.push(active ? 1 : 0); }
  const rows = await q<any>(`SELECT * FROM schemes WHERE ${clauses.join(' AND ')} ORDER BY LOWER(name) ASC`, params);
  const { slabs, premium, gradeRows } = await childrenFor(firmId, rows.map((r) => r.id));
  return rows.map((r) => mapScheme(r, slabs, premium, gradeRows));
}

function toInput(d: SchemeWrite): SchemeInput {
  return {
    kind: d.kind, period: d.period ?? null, windowFrom: d.windowFrom ?? null, windowTo: d.windowTo ?? null,
    qtyUnit: d.qtyUnit, valueType: d.valueType, premiumGradeIds: d.premiumGradeIds ?? [],
    minPremiumQty: d.minPremiumQty ?? 0, slabs: d.slabs, active: d.active,
  };
}

async function writeChildren(c: PoolConnection, firmId: string, schemeId: string, d: SchemeWrite): Promise<void> {
  await c.query('DELETE FROM scheme_slabs WHERE firm_id = ? AND scheme_id = ?', [firmId, schemeId]);
  await c.query('DELETE FROM scheme_premium_grades WHERE firm_id = ? AND scheme_id = ?', [firmId, schemeId]);
  await c.query('DELETE FROM scheme_grades WHERE firm_id = ? AND scheme_id = ?', [firmId, schemeId]);
  for (const g of normalizeGradeIds(d)) {
    await c.query('INSERT INTO scheme_grades (firm_id, scheme_id, grade_id) VALUES (?,?,?)', [firmId, schemeId, g]);
  }
  for (const s of sortSlabs(d.slabs)) {
    await c.query('INSERT INTO scheme_slabs (firm_id, scheme_id, slab_from, slab_value) VALUES (?,?,?,?)', [
      firmId, schemeId, s.from, s.value,
    ]);
  }
  for (const g of Array.from(new Set(d.premiumGradeIds ?? []))) {
    await c.query('INSERT INTO scheme_premium_grades (firm_id, scheme_id, grade_id) VALUES (?,?,?)', [firmId, schemeId, g]);
  }
}

const INSERT_SQL = `INSERT INTO schemes
  (firm_id, id, name, company_id, folder_id, grade_id, per_grade, source_id, kind, period, window_from, window_to,
   qty_unit, value_type, min_premium_qty, min_premium_unit, active, updated_by)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

function insertParams(firmId: string, id: string, d: SchemeWrite, userId: string): unknown[] {
  return [
    firmId, id, d.name, d.companyId, d.folderId ?? null, legacyGradeId(normalizeGradeIds(d)),
    d.perGrade ? 1 : 0, d.sourceId ?? null,
    d.kind, d.period ?? null, d.windowFrom ?? null, d.windowTo ?? null,
    d.qtyUnit, d.valueType, d.minPremiumQty ?? 0, d.minPremiumUnit ?? 'mt', d.active ? 1 : 0, userId,
  ];
}

async function checkFolder(firmId: string, folderId: string | null | undefined): Promise<void> {
  if (!folderId) return;
  const row = await qOne('SELECT id FROM scheme_folders WHERE firm_id = ? AND id = ? AND deleted_at IS NULL', [firmId, folderId]);
  if (!row) throw errors.validation('Unknown folder', [{ field: 'folderId', code: 'NOT_FOUND', message: 'Scheme folder not found' }]);
}

async function checkCompany(firmId: string, companyId: string): Promise<void> {
  const row = await qOne('SELECT id FROM companies WHERE firm_id = ? AND id = ? AND deleted_at IS NULL', [firmId, companyId]);
  if (!row) throw errors.validation('Unknown company', [{ field: 'companyId', code: 'NOT_FOUND', message: 'Company not found' }]);
}

export async function createScheme(firmId: string, userId: string, d: SchemeWrite): Promise<any> {
  validateScheme(toInput(d));
  await checkCompany(firmId, d.companyId);
  await checkFolder(firmId, d.folderId);
  const id = d.id ?? newId();
  // Read-back runs after commit: `fetchScheme` takes its own pooled connection,
  // and nesting that inside the transaction deadlocks the pool under concurrency.
  await tx(async (c) => {
    try {
      await c.query(INSERT_SQL, insertParams(firmId, id, d, userId));
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      const [rows] = await c.query('SELECT deleted_at FROM schemes WHERE firm_id = ? AND id = ?', [firmId, id]);
      const row = (rows as any[])[0];
      if (row && row.deleted_at === null) return; // idempotent (§1.2)
      await c.query('DELETE FROM schemes WHERE firm_id = ? AND id = ?', [firmId, id]);
      await c.query(INSERT_SQL, insertParams(firmId, id, d, userId));
    }
    await writeChildren(c, firmId, id, d);
  });
  return (await fetchScheme(firmId, id))!;
}

export async function patchScheme(firmId: string, userId: string, id: string, patch: Partial<SchemeWrite>, ifMatch: number | null): Promise<any> {
  const existing = await qOne<any>('SELECT * FROM schemes WHERE firm_id = ? AND id = ?', [firmId, id]);
  if (!existing || existing.deleted_at) throw errors.notFound('Scheme not found');
  const { slabs, premium, gradeRows } = await childrenFor(firmId, [id]);
  const currentWire = mapScheme(existing, slabs, premium, gradeRows);
  if (ifMatch !== null && Number(existing.rev) !== ifMatch) throw errors.revMismatch(currentWire);

  const merged: SchemeWrite = {
    name: patch.name ?? existing.name,
    companyId: patch.companyId ?? existing.company_id,
    // A patch that names neither grade field keeps the stored set; one that
    // names either replaces it wholesale, which is what normalizeGradeIds does.
    gradeIds:
      patch.gradeIds !== undefined || patch.gradeId !== undefined
        ? normalizeGradeIds(patch)
        : gradeRows.map((g) => g.grade_id),
    folderId: patch.folderId !== undefined ? patch.folderId : existing.folder_id,
    perGrade: patch.perGrade ?? !!existing.per_grade,
    sourceId: patch.sourceId !== undefined ? patch.sourceId : existing.source_id,
    kind: patch.kind ?? existing.kind,
    period: patch.period !== undefined ? patch.period : existing.period,
    windowFrom: patch.windowFrom !== undefined ? patch.windowFrom : existing.window_from,
    windowTo: patch.windowTo !== undefined ? patch.windowTo : existing.window_to,
    qtyUnit: patch.qtyUnit ?? existing.qty_unit,
    valueType: patch.valueType ?? existing.value_type,
    premiumGradeIds: patch.premiumGradeIds ?? premium.map((p) => p.grade_id),
    minPremiumQty: patch.minPremiumQty !== undefined ? patch.minPremiumQty : num(existing.min_premium_qty),
    minPremiumUnit: patch.minPremiumUnit ?? existing.min_premium_unit,
    slabs: patch.slabs ?? slabs.map((s) => ({ from: num(s.slab_from), value: num(s.slab_value) })),
    active: patch.active ?? !!existing.active,
  };
  validateScheme(toInput(merged));
  await checkCompany(firmId, merged.companyId);
  await checkFolder(firmId, merged.folderId);
  await tx(async (c) => {
    await c.query(
      `UPDATE schemes SET name=?, company_id=?, folder_id=?, grade_id=?, per_grade=?, source_id=?, kind=?, period=?,
         window_from=?, window_to=?, qty_unit=?, value_type=?, min_premium_qty=?, min_premium_unit=?, active=?,
         rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ?`,
      [
        merged.name, merged.companyId, merged.folderId ?? null, legacyGradeId(merged.gradeIds ?? []),
        merged.perGrade ? 1 : 0, merged.sourceId ?? null,
        merged.kind, merged.period ?? null, merged.windowFrom ?? null, merged.windowTo ?? null,
        merged.qtyUnit, merged.valueType, merged.minPremiumQty ?? 0, merged.minPremiumUnit ?? 'mt', merged.active ? 1 : 0,
        userId, firmId, id,
      ],
    );
    // `merged` always carries the full child state, so rewriting them is safe
    // even when the patch only moved a folder — but it is a delete + reinsert
    // of three tables, so it stays gated on a child field actually being named.
    if (patch.slabs !== undefined || patch.premiumGradeIds !== undefined
        || patch.gradeIds !== undefined || patch.gradeId !== undefined) {
      await writeChildren(c, firmId, id, merged);
    }
  });
  return (await fetchScheme(firmId, id))!;
}

export async function setActive(firmId: string, userId: string, id: string, active: boolean): Promise<any> {
  const [res]: any = await getPool().query(
    'UPDATE schemes SET active = ?, rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ? AND deleted_at IS NULL',
    [active ? 1 : 0, userId, firmId, id],
  );
  if (res.affectedRows === 0) throw errors.notFound('Scheme not found');
  return (await fetchScheme(firmId, id))!;
}

/** Scheme → claims delete is explicit in the service layer (§5.6 / §6.7 note). */
export async function deleteScheme(firmId: string, userId: string, id: string): Promise<void> {
  await tx(async (c) => {
    const [res]: any = await c.query(
      'UPDATE schemes SET deleted_at = UTC_TIMESTAMP(3), rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ? AND deleted_at IS NULL',
      [userId, firmId, id],
    );
    if (res.affectedRows > 0) {
      await c.query(
        'UPDATE claims SET deleted_at = UTC_TIMESTAMP(3), rev = rev + 1, updated_by = ? WHERE firm_id = ? AND scheme_id = ? AND deleted_at IS NULL',
        [userId, firmId, id],
      );
    }
  });
}
