import { getConfig } from '../../config';
import { GoogleSaError, googleAccessToken } from '../../lib/google_sa';
import { Plan } from '../plans/repo';

/**
 * Google Play Developer API (androidpublisher v3), over the same hand-rolled
 * service-account OAuth as FCM — no google-auth-library, for the reasons in
 * lib/google_sa.
 *
 * The two calls a server can make about a subscription are worth more than
 * they look. `getSubscriptionV2` is the only trustworthy answer to "has this
 * token paid?" — anything the phone says about a purchase is a claim until
 * Play confirms it. Acknowledgement is the other half: Play auto-refunds a
 * purchase that is not acknowledged within three days, so skipping it is
 * straight lost revenue.
 */

const BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

/**
 * The fields we read of a subscriptionsv2 resource. Play returns more; the
 * rest is deliberately not modelled, so Play adding a field is a non-event.
 */
export interface SubscriptionPurchaseV2 {
  /** ACKNOWLEDGEMENT_STATE_UNSPECIFIED | PENDING | ACKNOWLEDGED */
  acknowledgementState?: string;
  /** SUBSCRIPTION_STATE_* — see entitlementStatus */
  subscriptionState?: string;
  lineItems?: Array<{
    productId?: string;
    /** RFC3339 instant when this line item stops being paid-for. */
    expiryTime?: string;
    offerDetails?: { basePlanId?: string; offerId?: string };
  }>;
  /** Present when this token was replaced by a newer one (upgrade/downgrade). */
  linkedPurchaseToken?: string;
  latestOrderId?: string;
  startTime?: string;
}

/** Play answered with an error. `status` lets callers tell 404 from 5xx. */
export class PlayApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PlayApiError';
  }
}

async function callPlay(method: string, path: string, body?: unknown): Promise<any> {
  const cfg = getConfig();
  if (!cfg.PLAY_SA_KEY_FILE) throw new PlayApiError(0, 'PLAY_SA_KEY_FILE is not configured');
  let token: string;
  try {
    token = await googleAccessToken(cfg.PLAY_SA_KEY_FILE, SCOPE);
  } catch (e) {
    throw e instanceof PlayApiError
      ? e
      : new PlayApiError(e instanceof GoogleSaError ? e.status ?? 0 : 0, (e as Error).message);
  }
  const res = await fetch(
    `${BASE}/applications/${encodeURIComponent(cfg.PLAY_PACKAGE_NAME)}${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
  );
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!res.ok) {
    throw new PlayApiError(res.status, json.error?.message ?? `Play answered ${res.status}`);
  }
  return json;
}

/** Play's records for one purchase token — the only trustworthy answer. */
export function getSubscriptionV2(purchaseToken: string): Promise<SubscriptionPurchaseV2> {
  return callPlay('GET', `/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`);
}

/** What Play says is live on a track. */
export interface TrackRelease {
  versionCode: number;
  versionName: string;
}

/**
 * The build Play is actually serving on the production track.
 *
 * Used to tell running installs that a newer one exists. Reading it costs an
 * *edit* — the Publisher API has no plain "what is live" endpoint, so you open
 * a transaction, read the track and throw the transaction away. Nothing is
 * committed, so this changes nothing about the listing; the delete in the
 * `finally` is only tidiness, as an uncommitted edit expires on its own.
 *
 * Only `completed` releases count. A staged rollout is `inProgress` and is
 * being offered to a fraction of devices — announcing it to everyone would
 * put an "Update" button in front of people Play will not offer the update
 * to, which is worse than saying nothing. `halted` and `draft` are excluded
 * for the same reason.
 *
 * Returns null rather than throwing when Play is unreachable or unconfigured:
 * the caller's answer to "is there an update" is then "we do not know", which
 * is the right thing to tell an app that is working perfectly well already.
 */
export async function liveProductionRelease(): Promise<TrackRelease | null> {
  const cfg = getConfig();
  if (!cfg.PLAY_SA_KEY_FILE) return null;
  let editId: string | undefined;
  try {
    const edit = await callPlay('POST', '/edits', {});
    editId = edit?.id;
    if (!editId) return null;
    const track = await callPlay('GET', `/edits/${encodeURIComponent(editId)}/tracks/production`);
    const releases: any[] = Array.isArray(track?.releases) ? track.releases : [];
    let best: TrackRelease | null = null;
    for (const r of releases) {
      if (r?.status !== 'completed') continue;
      for (const raw of (r.versionCodes ?? []) as string[]) {
        const code = Number(raw);
        if (!Number.isFinite(code)) continue;
        // A release can carry several version codes (per-ABI splits); the
        // highest is the one a modern device installs.
        if (!best || code > best.versionCode) {
          best = { versionCode: code, versionName: String(r.name ?? '') };
        }
      }
    }
    return best;
  } catch {
    return null;
  } finally {
    if (editId) {
      await callPlay('DELETE', `/edits/${encodeURIComponent(editId)}`).catch(() => {});
    }
  }
}

/**
 * Idempotent, and safe to call on an already-acknowledged purchase — Play answers
 * 204 both ways. The body is an empty object: SubscriptionsAcknowledgeRequest
 * with no developerPayload.
 */
export async function acknowledgeSubscription(purchaseToken: string): Promise<void> {
  const cfg = getConfig();
  await callPlay(
    'POST',
    `/purchases/subscriptions/${encodeURIComponent(cfg.PLAY_PRODUCT_ID)}` +
      `/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`,
    {},
  );
}

/**
 * What a Play subscriptionState means for an entitlement, or null when the
 * purchase grants nothing right now.
 *
 * CANCELED counts if the paid-through time is still ahead: "cancelled" at Play
 * means "will not renew", not "access revoked" — the user already paid for the
 * rest of the period.
 */
export function entitlementStatus(
  p: SubscriptionPurchaseV2,
  now: number = Date.now(),
): 'active' | 'grace' | null {
  const expiry = p.lineItems?.[0]?.expiryTime;
  const paidThrough = expiry ? Date.parse(expiry) : NaN;
  switch (p.subscriptionState) {
    case 'SUBSCRIPTION_STATE_ACTIVE':
      return 'active';
    case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
      return 'grace';
    case 'SUBSCRIPTION_STATE_CANCELED':
      return Number.isFinite(paidThrough) && paidThrough > now ? 'active' : null;
    default:
      // PENDING / ON_HOLD / PAUSED / EXPIRED / anything new we don't know:
      // not paid for right now. Play does not say "maybe".
      return null;
  }
}

/**
 * Which plan row a purchase lands on.
 *
 * The sku on a plan is the Play product (`premium`); the base plan
 * (`monthly`/`yearly`) picks between the two rows that share it. A retired
 * (inactive) plan is still returned — whoever bought it keeps it. If no row
 * fits, null: the console has not been told about this product yet, and
 * inventing a plan would grant features nobody decided on.
 */
export function pickPlan(
  plans: Plan[],
  productId: string,
  basePlanId: string | undefined,
): Plan | null {
  // 'monthly'/'yearly' are the console's base-plan ids; 'month'/'year' the
  // plan row's period. Accept both so a config typo fails visibly, not silently.
  const aliases: Record<string, string> = { monthly: 'month', yearly: 'year' };
  const period = basePlanId ? (aliases[basePlanId] ?? basePlanId) : undefined;
  const sameProduct = plans.filter((p) => p.sku === productId);
  if (period) {
    const hit = sameProduct.find((p) => p.period === period);
    if (hit) return hit;
  }
  return sameProduct[0] ?? null;
}
