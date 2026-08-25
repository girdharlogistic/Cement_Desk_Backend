import { TtlCache } from '../../lib/cache';
import { Features, FREE_TIER, bestLimit } from './features';
import { EntitlementRow, EntitlementSource, getPlan, readEntitlement } from './repo';

/**
 * What a user may do right now: the plan's features, widened by whatever they
 * were grandfathered with, with the plan resolved and the expiry applied.
 */
export interface Entitlement {
  planId: string | null;
  planName: string;
  source: EntitlementSource | 'none';
  status: string;
  expiresAt: string | null;
  features: Features;
}

/**
 * Sixty seconds, and cleared outright whenever an entitlement is granted,
 * revoked or renewed. Long enough that the gates cost nothing on a polling
 * app; short enough that a Play renewal landing while the operator is watching
 * shows up before they start wondering.
 */
const ENTITLEMENT_TTL = 60_000;

const cache = new TtlCache<Entitlement>(ENTITLEMENT_TTL);

export function invalidateEntitlement(userId: string): void {
  cache.delete(userId);
}

/** For a change that could touch everybody — a plan's features being edited. */
export function invalidateAllEntitlements(): void {
  cache.clear();
}

export const FREE_ENTITLEMENT: Entitlement = {
  planId: null,
  planName: 'Free',
  source: 'none',
  status: 'free',
  expiresAt: null,
  features: FREE_TIER,
};

export async function entitlementOf(userId: string): Promise<Entitlement> {
  const hit = cache.get(userId);
  if (hit) return hit;
  const value = await load(userId);
  cache.set(userId, value);
  return value;
}

async function load(userId: string): Promise<Entitlement> {
  const row = await readEntitlement(userId);
  if (!row) return FREE_ENTITLEMENT;

  const plan = row.planId ? await getPlan(row.planId) : null;
  const live = isLive(row) && plan !== null;

  // A lapsed subscription falls back to the free tier's features, but the row
  // stays: it carries the grandfathering, and it is what the console shows when
  // somebody asks why a user lost something.
  const base = live ? plan!.features : FREE_TIER;

  return {
    planId: live ? plan!.id : null,
    planName: live ? plan!.name : 'Free',
    source: row.source,
    status: live ? row.status : row.status === 'active' ? 'expired' : row.status,
    expiresAt: row.expiresAt,
    features: {
      adFree: base.adFree,
      excelExport: base.excelExport,
      // Grandfathering outlives the plan on purpose. Somebody who had three
      // firms before any of this existed keeps three whether they subscribe,
      // lapse or never pay at all.
      maxFirms: bestLimit(base.maxFirms, row.grandfatheredFirms ?? 0),
      maxDevices: bestLimit(base.maxDevices, row.grandfatheredDevices ?? 0),
    },
  };
}

/**
 * `grace` counts as live — that is Play's payment-retry window, and cutting
 * somebody off during it is how you turn a failed card into a cancellation.
 */
function isLive(row: EntitlementRow): boolean {
  if (row.status !== 'active' && row.status !== 'grace') return false;
  if (!row.expiresAt) return true; // lifetime, or an open-ended grant
  return Date.parse(row.expiresAt) > Date.now();
}
