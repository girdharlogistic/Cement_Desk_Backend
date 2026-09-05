import { q, qOne, tx, Q } from '../../db/pool';
import { errors, isDuplicateKey } from '../../lib/errors';
import { isUuid, newId } from '../../lib/ids';

export type MasterTable = 'parties' | 'locations' | 'grades' | 'companies' | 'sources' | 'scheme_folders';

const TABLES: MasterTable[] = ['parties', 'locations', 'grades', 'companies', 'sources', 'scheme_folders'];

export function assertMasterTable(t: string): asserts t is MasterTable {
  if (!TABLES.includes(t as MasterTable)) throw errors.notFound('Unknown entity');
}

export async function getRow(table: MasterTable | 'party_routes', firmId: string, id: string): Promise<any | null> {
  return qOne(`SELECT * FROM ${table} WHERE firm_id = ? AND id = ?`, [firmId, id]);
}

export async function listRows(
  table: MasterTable | 'party_routes',
  firmId: string,
  includeDeleted: boolean,
  orderBy: string,
): Promise<any[]> {
  const whereDeleted = includeDeleted ? '' : 'AND deleted_at IS NULL';
  return q(`SELECT * FROM ${table} WHERE firm_id = ? ${whereDeleted} ${orderBy}`, [firmId]);
}

/**
 * Insert with client-supplied id (§1.2). If a row with that id exists (live or
 * tombstoned), treat as idempotent upsert: update in place, resurrect if needed.
 */
export async function createRow(
  table: MasterTable | 'party_routes',
  firmId: string,
  idIn: string | undefined,
  fields: Record<string, unknown>,
  userId: string,
): Promise<{ row: any; created: boolean }> {
  const id = idIn ?? newId();
  const cols = Object.keys(fields);
  const values = Object.values(fields);
  try {
    await q(
      `INSERT INTO ${table} (firm_id, id, ${cols.join(', ')}, updated_by) VALUES (?, ?, ${cols.map(() => '?').join(', ')}, ?)`,
      [firmId, id, ...values, userId],
    );
    return { row: (await getRow(table, firmId, id))!, created: true };
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    // The clash is only an idempotent re-insert when it is *this id* that already
    // exists. A natural-key clash (e.g. party_routes' UNIQUE(firm_id, party_id,
    // location_id) under a different id) must stay a duplicate-key error so the
    // caller can resolve it on its own key — otherwise the update below targets a
    // row that was never created and reports a spurious 404.
    if (!(await getRow(table, firmId, id))) throw e;
    await updateRow(table, firmId, id, fields, userId, null, true);
    return { row: (await getRow(table, firmId, id))!, created: false };
  }
}

export async function updateRow(
  table: MasterTable | 'party_routes',
  firmId: string,
  id: string,
  fields: Record<string, unknown>,
  userId: string,
  ifMatch: number | null,
  resurrect = false,
): Promise<any> {
  const existing = await getRow(table, firmId, id);
  if (!existing || (existing.deleted_at && !resurrect)) throw errors.notFound('Record not found');
  if (ifMatch !== null && Number(existing.rev) !== ifMatch) {
    return Promise.reject(errors.revMismatch(existing));
  }
  const cols = Object.keys(fields);
  if (cols.length === 0 && existing.deleted_at === null) return existing;
  await q(
    `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')}${cols.length ? ', ' : ''}rev = rev + 1, updated_by = ?${resurrect && existing.deleted_at ? ', deleted_at = NULL' : ''}
     WHERE firm_id = ? AND id = ?`,
    [...Object.values(fields), userId, firmId, id],
  );
  return (await getRow(table, firmId, id))!;
}

/** Soft delete (tombstone). Returns false when already absent/tombstoned. */
export async function softDeleteRow(
  c: Q,
  table: MasterTable | 'party_routes' | 'freight_entries' | 'stock_days' | 'purchases' | 'schemes' | 'claims',
  firmId: string,
  id: string,
  userId: string,
): Promise<boolean> {
  const [res]: any = await c.query(
    `UPDATE ${table} SET deleted_at = UTC_TIMESTAMP(3), rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ? AND deleted_at IS NULL`,
    [userId, firmId, id],
  );
  return res.affectedRows > 0;
}

/** Reorder in one transaction (§8.4) — positions become 0..n in given order. */
export async function reorderRows(table: MasterTable, firmId: string, ids: string[], userId: string): Promise<void> {
  if (!ids.every(isUuid)) throw errors.validation('ids must be UUIDs');
  await tx(async (c) => {
    for (let i = 0; i < ids.length; i++) {
      await c.query(
        `UPDATE ${table} SET sort_order = ?, updated_by = ? WHERE firm_id = ? AND id = ? AND deleted_at IS NULL`,
        [i, userId, firmId, ids[i]],
      );
    }
  });
}

/**
 * Soft-delete cascades mirroring §5.6. Child rows of owned child tables are
 * hard data (no sync columns); cross-parent references (party/grade appearing
 * in stock cells & baseline maps) are hard-deleted and their parent days get a
 * rev bump so the change propagates on the next pull.
 */
export async function deleteWithCascade(c: Q, table: MasterTable, firmId: string, id: string, userId: string): Promise<void> {
  const deleted = await softDeleteRow(c, table, firmId, id, userId);
  if (!deleted) return;

  if (table === 'parties') {
    await c.query(
      'UPDATE party_routes SET deleted_at = UTC_TIMESTAMP(3), rev = rev + 1, updated_by = ? WHERE firm_id = ? AND party_id = ? AND deleted_at IS NULL',
      [userId, firmId, id],
    );
    await c.query('DELETE FROM opening_baseline_party WHERE firm_id = ? AND party_id = ?', [firmId, id]);
    await bumpDaysForCellCleanup(c, firmId, 'party_id', id, userId);
  } else if (table === 'grades') {
    // DECISION D5 (safer option): refuse when purchases/schemes still reference.
    // Both grade columns have to be checked. `schemes.grade_id` is the legacy
    // single-grade field, still written for older clients; `scheme_grades` is
    // where a multi-grade scope actually lives, and a grade that appears only
    // there would otherwise be deletable out from under a live scheme.
    const [used] = await c.query(
      `SELECT (SELECT COUNT(*) FROM purchases WHERE firm_id = ? AND grade_id = ? AND deleted_at IS NULL) AS p,
              (SELECT COUNT(*) FROM schemes s2
                 WHERE s2.firm_id = ? AND s2.deleted_at IS NULL
                   AND (s2.grade_id = ?
                        OR EXISTS (SELECT 1 FROM scheme_grades g2
                                     WHERE g2.firm_id = s2.firm_id AND g2.scheme_id = s2.id AND g2.grade_id = ?))
              ) AS s`,
      [firmId, id, firmId, id, id],
    );
    const { p, s } = (used as any[])[0];
    if (Number(p) > 0 || Number(s) > 0) {
      throw errors.businessRule(
        `Grade is still referenced by ${p} purchase(s) and ${s} scheme(s); delete those first`,
      );
    }
    await c.query('DELETE FROM opening_baseline_stock WHERE firm_id = ? AND grade_id = ?', [firmId, id]);
    await c.query('DELETE FROM opening_baseline_party WHERE firm_id = ? AND grade_id = ?', [firmId, id]);
    await bumpDaysForCellCleanup(c, firmId, 'grade_id', id, userId);
    await c.query('DELETE FROM stock_receipts WHERE firm_id = ? AND grade_id = ?', [firmId, id]);
  } else if (table === 'companies') {
    // Company → purchases, schemes, claims (and orphan claims of those schemes) (§5.6).
    await c.query(
      'UPDATE purchases SET deleted_at = UTC_TIMESTAMP(3), rev = rev + 1, updated_by = ? WHERE firm_id = ? AND company_id = ? AND deleted_at IS NULL',
      [userId, firmId, id],
    );
    const [schemeRows] = await c.query('SELECT id FROM schemes WHERE firm_id = ? AND company_id = ?', [firmId, id]);
    const schemeIds = (schemeRows as any[]).map((r) => r.id);
    await c.query(
      'UPDATE schemes SET deleted_at = UTC_TIMESTAMP(3), rev = rev + 1, updated_by = ? WHERE firm_id = ? AND company_id = ? AND deleted_at IS NULL',
      [userId, firmId, id],
    );
    if (schemeIds.length) {
      await c.query(
        `UPDATE claims SET deleted_at = UTC_TIMESTAMP(3), rev = rev + 1, updated_by = ?
          WHERE firm_id = ? AND deleted_at IS NULL AND (company_id = ? OR scheme_id IN (${schemeIds.map(() => '?').join(',')}))`,
        [userId, firmId, id, ...schemeIds],
      );
    } else {
      await c.query(
        'UPDATE claims SET deleted_at = UTC_TIMESTAMP(3), rev = rev + 1, updated_by = ? WHERE firm_id = ? AND company_id = ? AND deleted_at IS NULL',
        [userId, firmId, id],
      );
    }
  } else if (table === 'scheme_folders') {
    // A folder is filing, not ownership: deleting one unfiles its schemes and
    // deletes none of them. The rev bump is what makes the change reach other
    // devices — the scheme row itself is what they pull, not the folder.
    await c.query(
      'UPDATE schemes SET folder_id = NULL, rev = rev + 1, updated_by = ? WHERE firm_id = ? AND folder_id = ?',
      [userId, firmId, id],
    );
  }
}

async function bumpDaysForCellCleanup(
  c: Q,
  firmId: string,
  column: 'party_id' | 'grade_id',
  refId: string,
  userId: string,
): Promise<void> {
  // Was MySQL's `UPDATE ... JOIN (subquery)`, which SQLite does not have. The
  // IN-subquery form does the same work and is what the multi-table syntax was
  // sugar for: bump every day that has a cell pointing at the row being
  // deleted, so the other devices pull the day and see the cell gone.
  await c.query(
    `UPDATE stock_days SET rev = rev + 1, updated_by = ?
      WHERE firm_id = ?
        AND id IN (
          SELECT stock_day_id FROM stock_day_cells WHERE firm_id = ? AND ${column} = ?
        )`,
    [userId, firmId, firmId, refId],
  );
  await c.query(`DELETE FROM stock_day_cells WHERE firm_id = ? AND ${column} = ?`, [firmId, refId]);
}
