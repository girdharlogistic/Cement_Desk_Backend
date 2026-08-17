import { PoolConnection } from 'mysql2/promise';
import { q, qOne, tx } from '../../db/pool';
import { errors, isDuplicateKey } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { num } from '../../lib/num';
import { syncMeta } from '../../plugins/guards';
import { validatePurchase } from '../../lib/validators';

export interface PurchaseWrite {
  id?: string;
  date: string;
  companyId: string;
  gradeId: string;
  sourceId: string;
  qty: number;
  ratePerBag: number;
  invoiceNo: string;
  payments?: { id?: string; date: string; amount: number }[];
}

export async function paymentsFor(c: PoolConnection | null, firmId: string, purchaseIds: string[]): Promise<any[]> {
  if (!purchaseIds.length) return [];
  const ph = purchaseIds.map(() => '?').join(',');
  const sql = `SELECT * FROM purchase_payments WHERE firm_id = ? AND purchase_id IN (${ph}) ORDER BY date ASC, id ASC`;
  const params = [firmId, ...purchaseIds];
  if (c) {
    const [rows] = await c.query(sql, params);
    return rows as any[];
  }
  return q(sql, params);
}

export function mapPurchase(r: any, payments: any[]): any {
  return {
    id: r.id,
    firmId: r.firm_id,
    date: r.date,
    companyId: r.company_id,
    gradeId: r.grade_id,
    sourceId: r.source_id,
    qty: num(r.qty),
    ratePerBag: num(r.rate_per_bag),
    invoiceNo: r.invoice_no ?? '',
    payments: payments
      .filter((p) => p.purchase_id === r.id)
      .map((p) => ({ id: p.id, date: p.date, amount: num(p.amount) })),
    ...syncMeta(r),
  };
}

export async function fetchPurchase(firmId: string, id: string): Promise<any | null> {
  const row = await qOne<any>('SELECT * FROM purchases WHERE firm_id = ? AND id = ?', [firmId, id]);
  if (!row) return null;
  return mapPurchase(row, await paymentsFor(null, firmId, [id]));
}

async function checkRefs(firmId: string, d: PurchaseWrite): Promise<void> {
  for (const [table, key, id] of [
    ['companies', 'companyId', d.companyId],
    ['grades', 'gradeId', d.gradeId],
    ['sources', 'sourceId', d.sourceId],
  ] as const) {
    const row = await qOne(`SELECT id FROM ${table} WHERE firm_id = ? AND id = ? AND deleted_at IS NULL`, [firmId, id]);
    if (!row) throw errors.validation(`Unknown ${key}`, [{ field: key, code: 'NOT_FOUND', message: `${key} not found` }]);
  }
}

async function writePayments(c: PoolConnection, firmId: string, purchaseId: string, payments: NonNullable<PurchaseWrite['payments']>): Promise<void> {
  for (const p of payments) {
    const pid = p.id ?? newId();
    // Additive ledger (§9.4): upsert by id, never conflicts.
    await c.query(
      `INSERT INTO purchase_payments (firm_id, id, purchase_id, date, amount) VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE date = VALUES(date), amount = VALUES(amount)`,
      [firmId, pid, purchaseId, p.date, p.amount],
    );
  }
}

export async function createPurchase(firmId: string, userId: string, d: PurchaseWrite): Promise<any> {
  validatePurchase(d);
  await checkRefs(firmId, d);
  const id = d.id ?? newId();
  const billValue = d.qty * d.ratePerBag;
  const paid = (d.payments ?? []).reduce((a, p) => a + p.amount, 0);
  void billValue;
  void paid;
  // Read-back runs after commit: `fetchPurchase` takes its own pooled connection,
  // and nesting that inside the transaction deadlocks the pool under concurrency.
  await tx(async (c) => {
    try {
      await c.query(
        `INSERT INTO purchases (firm_id, id, date, company_id, grade_id, source_id, qty, rate_per_bag, invoice_no, updated_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [firmId, id, d.date, d.companyId, d.gradeId, d.sourceId, d.qty, d.ratePerBag, d.invoiceNo, userId],
      );
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      const [rows] = await c.query('SELECT deleted_at FROM purchases WHERE firm_id = ? AND id = ?', [firmId, id]);
      const row = (rows as any[])[0];
      if (row && row.deleted_at === null) return; // idempotent re-insert (§1.2)
      await c.query('DELETE FROM purchases WHERE firm_id = ? AND id = ?', [firmId, id]); // purge tombstone, recreate fresh
      await c.query(
        `INSERT INTO purchases (firm_id, id, date, company_id, grade_id, source_id, qty, rate_per_bag, invoice_no, updated_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [firmId, id, d.date, d.companyId, d.gradeId, d.sourceId, d.qty, d.ratePerBag, d.invoiceNo, userId],
      );
    }
    await writePayments(c, firmId, id, d.payments ?? []);
  });
  return (await fetchPurchase(firmId, id))!;
}

const COL: Record<string, string> = {
  date: 'date', companyId: 'company_id', gradeId: 'grade_id', sourceId: 'source_id',
  qty: 'qty', ratePerBag: 'rate_per_bag', invoiceNo: 'invoice_no',
};

export async function patchPurchase(
  firmId: string, userId: string, id: string, patch: Partial<PurchaseWrite>, ifMatch: number | null,
): Promise<any> {
  const existing = await qOne<any>('SELECT * FROM purchases WHERE firm_id = ? AND id = ?', [firmId, id]);
  if (!existing || existing.deleted_at) throw errors.notFound('Purchase not found');
  if (ifMatch !== null && Number(existing.rev) !== ifMatch) {
    throw errors.revMismatch(mapPurchase(existing, await paymentsFor(null, firmId, [id])));
  }
  const merged: PurchaseWrite = {
    date: patch.date ?? existing.date,
    companyId: patch.companyId ?? existing.company_id,
    gradeId: patch.gradeId ?? existing.grade_id,
    sourceId: patch.sourceId ?? existing.source_id,
    qty: num(patch.qty ?? existing.qty),
    ratePerBag: num(patch.ratePerBag ?? existing.rate_per_bag),
    invoiceNo: patch.invoiceNo ?? existing.invoice_no ?? '',
  };
  validatePurchase(merged);
  await checkRefs(firmId, merged);
  await tx(async (c) => {
    const keys = Object.keys(patch).filter((k) => k in COL && k !== 'id');
    if (!keys.length) return;
    await c.query(
      `UPDATE purchases SET ${keys.map((k) => `${COL[k]} = ?`).join(', ')}, rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ?`,
      [...keys.map((k) => (merged as any)[k]), userId, firmId, id],
    );
  });
  return (await fetchPurchase(firmId, id))!;
}

export async function deletePurchase(firmId: string, userId: string, id: string): Promise<void> {
  await q(
    'UPDATE purchases SET deleted_at = UTC_TIMESTAMP(3), rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ? AND deleted_at IS NULL',
    [userId, firmId, id],
  );
}

export async function addPayment(firmId: string, userId: string, purchaseId: string, p: { id?: string; date: string; amount: number }): Promise<any> {
  const purchase = await qOne<any>('SELECT id, deleted_at FROM purchases WHERE firm_id = ? AND id = ?', [firmId, purchaseId]);
  if (!purchase || purchase.deleted_at) throw errors.notFound('Purchase not found');
  if (!(p.amount >= 0)) throw errors.validation('amount must be >= 0', [{ field: 'amount', code: 'MUST_BE_NON_NEGATIVE', message: 'amount must be >= 0' }]);
  const id = p.id ?? newId();
  await tx(async (c) => {
    await c.query(
      `INSERT INTO purchase_payments (firm_id, id, purchase_id, date, amount) VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE date = VALUES(date), amount = VALUES(amount)`,
      [firmId, id, purchaseId, p.date, p.amount],
    );
    // Child mutation bumps parent so sync pull picks it up (§9.2).
    await c.query('UPDATE purchases SET rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ?', [userId, firmId, purchaseId]);
  });
  return (await fetchPurchase(firmId, purchaseId))!;
}

export async function deletePayment(firmId: string, userId: string, purchaseId: string, paymentId: string): Promise<any> {
  const purchase = await qOne<any>('SELECT id, deleted_at FROM purchases WHERE firm_id = ? AND id = ?', [firmId, purchaseId]);
  if (!purchase || purchase.deleted_at) throw errors.notFound('Purchase not found');
  await tx(async (c) => {
    await c.query('DELETE FROM purchase_payments WHERE firm_id = ? AND id = ? AND purchase_id = ?', [firmId, paymentId, purchaseId]);
    await c.query('UPDATE purchases SET rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ?', [userId, firmId, purchaseId]);
  });
  return (await fetchPurchase(firmId, purchaseId))!;
}

export async function listPurchases(
  firmId: string,
  opts: { from?: string; to?: string; companyId?: string; gradeId?: string; limit: number; cursor?: { date: string; id: string } },
): Promise<{ rows: any[]; nextCursor: string | null }> {
  const clauses = ['firm_id = ?', 'deleted_at IS NULL'];
  const params: unknown[] = [firmId];
  if (opts.from) { clauses.push('date >= ?'); params.push(opts.from); }
  if (opts.to) { clauses.push('date <= ?'); params.push(opts.to); }
  if (opts.companyId) { clauses.push('company_id = ?'); params.push(opts.companyId); }
  if (opts.gradeId) { clauses.push('grade_id = ?'); params.push(opts.gradeId); }
  if (opts.cursor) {
    clauses.push('(date < ? OR (date = ? AND id < ?))');
    params.push(opts.cursor.date, opts.cursor.date, opts.cursor.id);
  }
  const rows = await q<any>(
    `SELECT * FROM purchases WHERE ${clauses.join(' AND ')} ORDER BY date DESC, id DESC LIMIT ?`,
    [...params, opts.limit + 1],
  );
  let nextCursor: string | null = null;
  if (rows.length > opts.limit) {
    rows.length = opts.limit;
    const last = rows[rows.length - 1];
    nextCursor = Buffer.from(JSON.stringify({ d: last.date, i: last.id })).toString('base64url');
  }
  const payments = await paymentsFor(null, firmId, rows.map((r) => r.id));
  return { rows: rows.map((r) => mapPurchase(r, payments)), nextCursor };
}
