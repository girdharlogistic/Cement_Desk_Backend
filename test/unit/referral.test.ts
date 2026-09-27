import { describe, expect, it } from 'vitest';
import { hasPaid, SubscriptionPurchaseV2 } from '../../src/modules/billing/play';
import {
  generateCode,
  maskEmail,
  normalizeCode,
  normalizeUpi,
} from '../../src/modules/referral/service';

const FUTURE = '2999-01-01T00:00:00Z';
const PAST = '2001-01-01T00:00:00Z';
const DAY = 86_400_000;

function sub(
  state: string,
  extra: Partial<NonNullable<SubscriptionPurchaseV2['lineItems']>[number]> = {},
  startTime?: string,
): SubscriptionPurchaseV2 {
  return {
    subscriptionState: state,
    startTime,
    lineItems: [{ productId: 'premium', expiryTime: FUTURE, ...extra }],
  };
}

describe('hasPaid — the referral bonus is cash, a trial is not a payment', () => {
  it('pays on an active subscription at its base price', () => {
    expect(hasPaid(sub('SUBSCRIPTION_STATE_ACTIVE', { offerPhase: { basePrice: {} } }))).toBe(true);
  });

  it('does not pay during a free trial', () => {
    expect(hasPaid(sub('SUBSCRIPTION_STATE_ACTIVE', { offerPhase: { freeTrial: {} } }))).toBe(false);
  });

  it('does not pay while a charge is failing (grace) or on hold', () => {
    for (const s of ['SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_ON_HOLD', 'SUBSCRIPTION_STATE_PENDING']) {
      expect(hasPaid(sub(s, { offerPhase: { basePrice: {} } }))).toBe(false);
    }
  });

  it('counts a paid subscription whose renewal was switched off', () => {
    expect(hasPaid(sub('SUBSCRIPTION_STATE_CANCELED', { offerPhase: { basePrice: {} } }))).toBe(true);
    expect(hasPaid(sub('SUBSCRIPTION_STATE_CANCELED', { expiryTime: PAST, offerPhase: { basePrice: {} } }))).toBe(false);
  });

  it('without offerPhase: a plain base plan is paid', () => {
    expect(hasPaid(sub('SUBSCRIPTION_STATE_ACTIVE', { offerDetails: { basePlanId: 'monthly' } }))).toBe(true);
  });

  it('without offerPhase: a trial offer is paid only once its length has run out', () => {
    const now = Date.parse('2026-09-27T00:00:00Z');
    const started = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();
    const trial = (daysAgo: number) =>
      sub('SUBSCRIPTION_STATE_ACTIVE', { offerDetails: { basePlanId: 'monthly', offerId: 'trial30' } }, started(daysAgo));
    expect(hasPaid(trial(3), now)).toBe(false);
    expect(hasPaid(trial(29), now)).toBe(false);
    expect(hasPaid(trial(31), now)).toBe(true);
    // No start time: we cannot tell, so no.
    expect(hasPaid(sub('SUBSCRIPTION_STATE_ACTIVE', { offerDetails: { offerId: 'trial30' } }), now)).toBe(false);
  });
});

describe('referral codes and UPI IDs', () => {
  it('codes avoid the characters people misread', () => {
    for (let i = 0; i < 200; i++) expect(generateCode()).toMatch(/^[A-HJKMNP-Z2-9]{7}$/);
  });

  it('normalises a code as typed', () => {
    expect(normalizeCode(' ab3-k9 x ')).toBe('AB3K9X');
  });

  it('accepts real UPI IDs and lower-cases them', () => {
    expect(normalizeUpi('Rahul.Sharma@OKAXIS')).toBe('rahul.sharma@okaxis');
    expect(normalizeUpi('9876543210@ybl')).toBe('9876543210@ybl');
    expect(normalizeUpi(' name_1-x@paytm ')).toBe('name_1-x@paytm');
  });

  it('refuses things that are not UPI IDs', () => {
    for (const bad of ['', 'rahul', '@okaxis', 'rahul@', 'rahul@9bank', 'ra hul@okaxis', 'a@b@c']) {
      expect(normalizeUpi(bad)).toBeNull();
    }
  });

  it('masks a referee email', () => {
    expect(maskEmail('rahul@gmail.com')).toBe('ra•••@gmail.com');
    expect(maskEmail('r@x.in')).toBe('r•••@x.in');
  });
});

describe('qualifiesForBonus — yearly only', () => {
  it('pays for a paid yearly plan, not a paid monthly one', async () => {
    const { qualifiesForBonus } = await import('../../src/modules/referral/service');
    const p = sub('SUBSCRIPTION_STATE_ACTIVE', { offerPhase: { basePrice: {} } });
    expect(qualifiesForBonus(p, 'year')).toBe(true);
    expect(qualifiesForBonus(p, 'month')).toBe(false);
    expect(qualifiesForBonus(sub('SUBSCRIPTION_STATE_ACTIVE', { offerPhase: { freeTrial: {} } }), 'year')).toBe(false);
  });
});
