import { z } from 'zod';
import { q, qOne } from '../../db/pool';
import { newId } from '../../lib/ids';
import { sqlToIso } from '../../lib/dates';
import { Features, FeaturesInput, parseFeatures } from './features';

export type PlanPeriod = 'month' | 'year' | 'lifetime';
export type EntitlementSource = 'grant' | 'play' | 'code';
export type EntitlementStatus = 'active' | 'grace' | 'expired' | 'cancelled';

export interface Plan {
  id: string;
  name: string;
  description: string;
  /** The Play product this plan is bought as. Empty for grant-only plans. */
  sku: string;
  period: PlanPeriod;
  features: Features;
  sortOrder: number;
  active: boolean;
}

export interface EntitlementRow {
  userId: string;
  planId: string | null;
  source: EntitlementSource;
  status: EntitlementStatus;
  expiresAt: string | null;
  purchaseToken: string;
  note: string;
  grandfatheredFirms: number | null;
  grandfatheredDevices: number | null;
}

/**
 * What the console may save.
 *
 * Note what is *not* here: a price. Play owns money — the app reads the live
 * price off Play Billing against [sku], so a price typed here could only ever
 * disagree with what the user is actually charged. The one thing the operator
 * sets about money is which Play product this plan is.
 */
export const PlanInput = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).default(''),
  sku: z.string().trim().max(120).default(''),
  period: z.enum(['month', 'year', 'lifetime']).default('month'),
  features: FeaturesInput,
  sortOrder: z.number().int().min(0).max(999).default(0),
  active: z.boolean().default(true),
});

export type PlanInputType = z.infer<typeof PlanInput>;

function mapPlan(r: any): Plan {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    sku: r.sku,
    period: r.period,
    features: parseFeatures(r.features),
    sortOrder: Number(r.sort_order),
    active: r.active === 1,
  };
}

export async function listPlans(includeHidden: boolean): Promise<Plan[]> {
  const rows = await q<any>(
    `SELECT * FROM plans ${includeHidden ? '' : 'WHERE active = 1'}
      ORDER BY sort_order ASC, name ASC`,
  );
  return rows.map(mapPlan);
}

export async function getPlan(id: string): Promise<Plan | null> {
  const r = await qOne<any>('SELECT * FROM plans WHERE id = ?', [id]);
  return r ? mapPlan(r) : null;
}

export async function createPlan(input: PlanInputType): Promise<Plan> {
  const id = newId();
  await q(
    `INSERT INTO plans (id, name, description, sku, period, features, sort_order, active)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      id,
      input.name,
      input.description,
      input.sku,
      input.period,
      JSON.stringify(input.features),
      input.sortOrder,
      input.active ? 1 : 0,
    ],
  );
  return (await getPlan(id))!;
}

export async function updatePlan(id: string, input: PlanInputType): Promise<Plan | null> {
  await q(
    `UPDATE plans SET name = ?, description = ?, sku = ?, period = ?, features = ?,
            sort_order = ?, active = ?
      WHERE id = ?`,
    [
      input.name,
      input.description,
      input.sku,
      input.period,
      JSON.stringify(input.features),
      input.sortOrder,
      input.active ? 1 : 0,
      id,
    ],
  );
  return getPlan(id);
}

/**
 * Plans are never deleted while anybody holds them.
 *
 * A deleted plan would orphan its entitlements, and an orphaned entitlement
 * silently becomes the free tier — somebody who paid quietly losing what they
 * paid for. Retiring a price is what `active = 0` is for: it stops being
 * offered and keeps working for everyone who already bought it.
 */
export async function deletePlan(id: string): Promise<{ deleted: boolean; holders: number }> {
  const row = await qOne<{ n: number }>('SELECT COUNT(*) AS n FROM entitlements WHERE plan_id = ?', [
    id,
  ]);
  const holders = Number(row?.n ?? 0);
  if (holders > 0) return { deleted: false, holders };
  await q('DELETE FROM plans WHERE id = ?', [id]);
  return { deleted: true, holders: 0 };
}

export function mapEntitlement(r: any): EntitlementRow {
  return {
    userId: r.user_id,
    planId: r.plan_id ?? null,
    source: r.source,
    status: r.status,
    expiresAt: sqlToIso(r.expires_at),
    purchaseToken: r.purchase_token ?? '',
    note: r.note ?? '',
    grandfatheredFirms: r.grandfathered_firms === null ? null : Number(r.grandfathered_firms),
    grandfatheredDevices: r.grandfathered_devices === null ? null : Number(r.grandfathered_devices),
  };
}

export async function readEntitlement(userId: string): Promise<EntitlementRow | null> {
  const r = await qOne<any>('SELECT * FROM entitlements WHERE user_id = ?', [userId]);
  return r ? mapEntitlement(r) : null;
}

/**
 * Who holds this Play purchase token, if anyone.
 *
 * `purchase_token != ''` because free-tier rows (grandfathering, revokes) all
 * carry an empty token — the index is on the column itself, so every free row
 * would otherwise match every lookup of a token that was never granted.
 */
export async function readEntitlementByToken(purchaseToken: string): Promise<EntitlementRow | null> {
  const r = await qOne<any>(
    `SELECT * FROM entitlements WHERE purchase_token = ? AND purchase_token != ''`,
    [purchaseToken],
  );
  return r ? mapEntitlement(r) : null;
}

export interface EntitlementUpsert {
  userId: string;
  planId: string | null;
  source: EntitlementSource;
  status: EntitlementStatus;
  /** Already in SQL datetime form, or null for no expiry. */
  expiresAtSql: string | null;
  purchaseToken?: string;
  note?: string;
}

/**
 * Grants or replaces a user's entitlement, keeping whatever grandfathering
 * they already had.
 *
 * The grandfathering is deliberately *not* overwritable from here: it records
 * what somebody had before plans existed, it is not part of the plan, and a
 * grant that quietly dropped it would take firms away from a user the moment
 * an operator tried to give them something.
 */
export async function upsertEntitlement(e: EntitlementUpsert): Promise<void> {
  await q(
    `INSERT INTO entitlements (user_id, plan_id, source, status, expires_at, purchase_token, note)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT (user_id) DO UPDATE SET
       plan_id = excluded.plan_id, source = excluded.source, status = excluded.status,
       expires_at = excluded.expires_at, purchase_token = excluded.purchase_token,
       note = excluded.note`,
    [e.userId, e.planId, e.source, e.status, e.expiresAtSql, e.purchaseToken ?? '', e.note ?? ''],
  );
}

/** Drops a user back to the free tier, grandfathering included. */
export async function revokeEntitlement(userId: string): Promise<void> {
  await q(
    `UPDATE entitlements SET plan_id = NULL, status = 'cancelled', expires_at = NULL,
            purchase_token = '', note = ''
      WHERE user_id = ?`,
    [userId],
  );
}
