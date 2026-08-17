import { PoolConnection } from 'mysql2/promise';
import { q, qOne, tx } from '../../db/pool';
import { errors, isDuplicateKey } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { num } from '../../lib/num';
import { syncMeta } from '../../plugins/guards';
import { validateClaim, claimAutoStatus } from '../../lib/validators';

export interface ClaimWrite {
  id?: string;
  schemeId: string;
  companyId: string;
  schemeName: string;
  periodFrom: string;
  periodTo: string;
  label: string;
  bags: number;
  accrued: number;
}

/** Fields that are frozen after creation (§5.4). */
const IMMUTABLE = ['bags', 'accrued', 'periodFrom', 'periodTo', 'label', 'schemeId', 'companyId'] as const;

export function mapClaim(r: any, creditNotes: any[]): any {
  const notes = creditNotes.filter((x) => x.claim_id === r.id);
  const receivedAmount = notes.reduce((a, x) => a + num(x.amount), 0);
  return {
    id: r.id,
    firmId: r.firm_id,
    schemeId: r.scheme_id,
    companyId: r.company_id,
    schemeName: r.scheme_name ?? '',
    periodFrom: r.period_from,
    periodTo: r.period_to,
    label: r.label ?? '',
    bags: num(r.bags),
    accrued: num(r.accrued),
    status: r.status,
    sentOn: r.sent_on ?? null,
    creditNotes: notes.map((x) => ({ id: x.id, date: x.date, number: x.number ?? '', amount: num(x.amount) })),
    receivedAmount, // derived, never stored
    pendingAmount: num(r.accrued) - receivedAmount, // derived, never stored
    ...syncMeta(r),
  };
}

async function notesFor(firmId: string, claimIds: string[]): Promise<any[]> {
  if (!claimIds.length) return [];
  return q(
    `SELECT * FROM claim_credit_notes WHERE firm_id = ? AND claim_id IN (${claimIds.map(() => '?').join(',')}) ORDER BY date ASC, id ASC`,
    [firmId, ...claimIds],
  );
}

export async function fetchClaim(firmId: string, id: string): Promise<any | null> {
  const r = await qOne<any>('SELECT * FROM claims WHERE firm_id = ? AND id = ?', [firmId, id]);
  if (!r) return null;
  return mapClaim(r, await notesFor(firmId, [id]));
}

export async function listClaims(firmId: string, status?: string, companyId?: string): Promise<any[]> {
  const clauses = ['firm_id = ?', 'deleted_at IS NULL'];
  const params: unknown[] = [firmId];
  if (status) { clauses.push('status = ?'); params.push(status); }
  if (companyId) { clauses.push('company_id = ?'); params.push(companyId); }
  const rows = await q<any>(`SELECT * FROM claims WHERE ${clauses.join(' AND ')} ORDER BY period_from DESC, id DESC`, params);
  const notes = await notesFor(firmId, rows.map((r) => r.id));
  return rows.map((r) => mapClaim(r, notes));
}

export async function createClaim(firmId: string, userId: string, d: ClaimWrite): Promise<any> {
  validateClaim(d);
  const id = d.id ?? newId();
  // Read-back runs after commit: `fetchClaim` takes its own pooled connection,
  // and nesting that inside the transaction deadlocks the pool under concurrency.
  await tx(async (c) => {
    try {
      await insertClaim(c, firmId, id, d, userId);
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      // uk_claim_period (or PK) hit: live row → 409; tombstone → purge & recreate.
      const [rows] = await c.query(
        'SELECT id, deleted_at FROM claims WHERE firm_id = ? AND (id = ? OR (scheme_id = ? AND period_from = ?))',
        [firmId, id, d.schemeId, d.periodFrom],
      );
      // Prefer a live clash if there is one, so a live row is never silently purged
      // just because a tombstone happened to sort first.
      const all = rows as any[];
      const clash = all.find((r) => r.deleted_at === null) ?? all[0];
      if (!clash) {
        // Raced by a concurrent insert that has since gone; surface it as a conflict
        // rather than dereferencing undefined.
        throw errors.duplicateKey('A claim already exists for this scheme and period');
      }
      if (clash.deleted_at === null) {
        throw errors.duplicateKey('A claim already exists for this scheme and period');
      }
      await c.query('DELETE FROM claims WHERE firm_id = ? AND id = ?', [firmId, clash.id]);
      await insertClaim(c, firmId, id, d, userId);
    }
  });
  return (await fetchClaim(firmId, id))!;
}

async function insertClaim(c: PoolConnection, firmId: string, id: string, d: ClaimWrite, userId: string): Promise<void> {
  await c.query(
    `INSERT INTO claims (firm_id, id, scheme_id, company_id, scheme_name, period_from, period_to, label, bags, accrued, updated_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [firmId, id, d.schemeId, d.companyId, d.schemeName, d.periodFrom, d.periodTo, d.label, d.bags, d.accrued, userId],
  );
}

export async function patchClaim(
  firmId: string,
  userId: string,
  id: string,
  patch: { status?: string; sentOn?: string | null; schemeName?: string; [k: string]: unknown },
  ifMatch: number | null,
): Promise<any> {
  const r = await qOne<any>('SELECT * FROM claims WHERE firm_id = ? AND id = ?', [firmId, id]);
  if (!r || r.deleted_at) throw errors.notFound('Claim not found');
  if (ifMatch !== null && Number(r.rev) !== ifMatch) {
    throw errors.revMismatch(mapClaim(r, await notesFor(firmId, [id])));
  }
  // §5.4: frozen fields may not change (identical echo is a tolerated no-op).
  for (const f of IMMUTABLE) {
    if (patch[f] === undefined) continue;
    const col = { bags: 'bags', accrued: 'accrued', periodFrom: 'period_from', periodTo: 'period_to', label: 'label', schemeId: 'scheme_id', companyId: 'company_id' }[f];
    const cur = (r as any)[col];
    const next = patch[f];
    if (['bags', 'accrued'].includes(f) ? Math.abs(num(cur) - num(next)) > 0.01 : String(cur ?? '') !== String(next ?? '')) {
      throw errors.claimImmutable(f);
    }
  }
  const sets: string[] = [];
  const vals: unknown[] = [];
  // `status` is deliberately NOT set from the patch here — the auto-transition
  // below already folds patch.status into the value that gets written, and
  // assigning the column twice in one SET is a silent last-one-wins trap.
  if (patch.sentOn !== undefined) { sets.push('sent_on = ?'); vals.push(patch.sentOn); }
  if (patch.schemeName !== undefined) { sets.push('scheme_name = ?'); vals.push(patch.schemeName); }

  // Apply auto-transition on the post-patch state (§5.4).
  const notes = await notesFor(firmId, [id]);
  const receivedAmount = notes.reduce((a, x) => a + num(x.amount), 0);
  const status = claimAutoStatus({
    status: (patch.status ?? r.status) as any,
    accrued: num(r.accrued),
    receivedAmount,
    hasCreditNotes: notes.length > 0,
    sentOn: patch.sentOn !== undefined ? patch.sentOn : (r.sent_on ?? null),
  });
  sets.push('status = ?');
  vals.push(status);

  if (sets.length) {
    await q(`UPDATE claims SET ${sets.join(', ')}, rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ?`, [
      ...vals, userId, firmId, id,
    ]);
  }
  return (await fetchClaim(firmId, id))!;
}

export async function addCreditNote(
  firmId: string, userId: string, claimId: string, n: { id?: string; date: string; number: string; amount: number },
): Promise<any> {
  const r = await qOne<any>('SELECT * FROM claims WHERE firm_id = ? AND id = ?', [firmId, claimId]);
  if (!r || r.deleted_at) throw errors.notFound('Claim not found');
  const id = n.id ?? newId();
  await tx(async (c) => {
    await c.query(
      `INSERT INTO claim_credit_notes (firm_id, id, claim_id, date, number, amount) VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE date = VALUES(date), number = VALUES(number), amount = VALUES(amount)`,
      [firmId, id, claimId, n.date, n.number, n.amount],
    );
    await applyAutoStatus(c, firmId, claimId, userId);
  });
  return (await fetchClaim(firmId, claimId))!;
}

export async function deleteCreditNote(firmId: string, userId: string, claimId: string, noteId: string): Promise<any> {
  const r = await qOne<any>('SELECT id, deleted_at FROM claims WHERE firm_id = ? AND id = ?', [firmId, claimId]);
  if (!r || r.deleted_at) throw errors.notFound('Claim not found');
  await tx(async (c) => {
    await c.query('DELETE FROM claim_credit_notes WHERE firm_id = ? AND id = ? AND claim_id = ?', [firmId, noteId, claimId]);
    await applyAutoStatus(c, firmId, claimId, userId);
  });
  return (await fetchClaim(firmId, claimId))!;
}

/** Recompute + persist status after credit-note changes; bump parent rev (§9.2). */
async function applyAutoStatus(c: PoolConnection, firmId: string, claimId: string, userId: string): Promise<void> {
  const [claims] = await c.query('SELECT status, accrued, sent_on FROM claims WHERE firm_id = ? AND id = ?', [firmId, claimId]);
  const r = (claims as any[])[0];
  if (!r) return;
  const [notes] = await c.query('SELECT amount FROM claim_credit_notes WHERE firm_id = ? AND claim_id = ?', [firmId, claimId]);
  const list = notes as any[];
  const receivedAmount = list.reduce((a, x) => a + num(x.amount), 0);
  const status = claimAutoStatus({
    status: r.status,
    accrued: num(r.accrued),
    receivedAmount,
    hasCreditNotes: list.length > 0,
    sentOn: r.sent_on ?? null,
  });
  await c.query('UPDATE claims SET status = ?, rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ?', [
    status, userId, firmId, claimId,
  ]);
}

export async function deleteClaim(firmId: string, userId: string, id: string): Promise<void> {
  await q(
    'UPDATE claims SET deleted_at = UTC_TIMESTAMP(3), rev = rev + 1, updated_by = ? WHERE firm_id = ? AND id = ? AND deleted_at IS NULL',
    [userId, firmId, id],
  );
}
