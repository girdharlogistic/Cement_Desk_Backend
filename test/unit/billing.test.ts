import { describe, expect, it } from 'vitest';
import {
  SubscriptionPurchaseV2,
  entitlementStatus,
  pickPlan,
} from '../../src/modules/billing/play';
import { Plan } from '../../src/modules/plans/repo';

const FUTURE = '2999-01-01T00:00:00Z';
const PAST = '2001-01-01T00:00:00Z';

function purchase(state: string, expiryTime: string = FUTURE): SubscriptionPurchaseV2 {
  return {
    subscriptionState: state,
    lineItems: [{ productId: 'premium', expiryTime }],
  };
}

describe('entitlementStatus', () => {
  it('maps an active subscription to active', () => {
    expect(entitlementStatus(purchase('SUBSCRIPTION_STATE_ACTIVE'))).toBe('active');
  });

  it('maps the payment-retry window to grace — cutting off here costs cancels', () => {
    expect(entitlementStatus(purchase('SUBSCRIPTION_STATE_IN_GRACE_PERIOD'))).toBe('grace');
  });

  it('keeps a cancelled subscription alive until the paid-through date', () => {
    expect(entitlementStatus(purchase('SUBSCRIPTION_STATE_CANCELED', FUTURE))).toBe('active');
  });

  it('drops a cancelled subscription whose period has run out', () => {
    expect(entitlementStatus(purchase('SUBSCRIPTION_STATE_CANCELED', PAST))).toBeNull();
  });

  it('grants nothing for suspended, pending or expired purchases', () => {
    for (const state of [
      'SUBSCRIPTION_STATE_PENDING',
      'SUBSCRIPTION_STATE_PAUSED',
      'SUBSCRIPTION_STATE_ON_HOLD',
      'SUBSCRIPTION_STATE_EXPIRED',
    ]) {
      expect(entitlementStatus(purchase(state))).toBeNull();
    }
  });

  it('grants nothing for a state Play has not invented yet', () => {
    expect(entitlementStatus(purchase('SUBSCRIPTION_STATE_WHATEVER_NEXT'))).toBeNull();
    expect(entitlementStatus({})).toBeNull();
  });

  it('honours the injected clock', () => {
    const p = purchase('SUBSCRIPTION_STATE_CANCELED', '2030-06-15T00:00:00Z');
    expect(entitlementStatus(p, Date.parse('2030-06-14T00:00:00Z'))).toBe('active');
    expect(entitlementStatus(p, Date.parse('2030-06-16T00:00:00Z'))).toBeNull();
  });
});

function plan(id: string, sku: string, period: Plan['period'], active = true): Plan {
  return {
    id,
    name: id,
    description: '',
    sku,
    period,
    features: { adFree: true, excelExport: true, maxFirms: -1, maxDevices: -1 },
    sortOrder: 0,
    active,
  };
}

const PLANS = [
  plan('m', 'premium', 'month'),
  plan('y', 'premium', 'year'),
  plan('retired', 'premium', 'lifetime', false),
];

describe('pickPlan', () => {
  it('matches base plan ids to the plan period', () => {
    expect(pickPlan(PLANS, 'premium', 'monthly')?.id).toBe('m');
    expect(pickPlan(PLANS, 'premium', 'yearly')?.id).toBe('y');
  });

  it('also accepts the period names Play Console uses elsewhere', () => {
    expect(pickPlan(PLANS, 'premium', 'month')?.id).toBe('m');
    expect(pickPlan(PLANS, 'premium', 'year')?.id).toBe('y');
  });

  it('falls back to the product when the base plan is unknown', () => {
    expect(pickPlan(PLANS, 'premium', undefined)?.id).toBe('m');
    expect(pickPlan(PLANS, 'premium', 'some-future-base-plan')?.id).toBe('m');
  });

  it('still finds retired plans — a price stops being offered, it never stops working', () => {
    expect(pickPlan([plan('old', 'prem-old', 'month', false)], 'prem-old', 'month')?.id).toBe('old');
  });

  it('returns null when nothing matches — no plan, no features, loudly', () => {
    expect(pickPlan(PLANS, 'platinum', 'monthly')).toBeNull();
    expect(pickPlan([], 'premium', 'monthly')).toBeNull();
  });
});
