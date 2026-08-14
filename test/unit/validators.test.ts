import { describe, it, expect } from 'vitest';
import {
  validateFreightEntry, validateScheme, validateClaim, validatePurchase,
  sortSlabs, claimAutoStatus,
} from '../../src/lib/validators';
import { AppError } from '../../src/lib/errors';

// Every rule of §5.5, pass + fail cases (§15.1).

describe('validateFreightEntry (§5.5 / §3.5 formula)', () => {
  const good = {
    revenuePerBag: 200, bags: 100, totalReimbursed: 20000,
    basis: 'km' as const, costRate: 12, costUnits: 900, otherExpenses: 500,
    totalCost: 12 * 900 + 500, profit: 20000 - (12 * 900 + 500),
  };
  it('accepts a correct km-basis entry', () => expect(() => validateFreightEntry(good)).not.toThrow());
  it('accepts a correct bag-basis (self-lifting) entry — units mirror bags', () => {
    const bag = { ...good, basis: 'bag' as const, costRate: 8, costUnits: 0, totalCost: 8 * 100 + 500, profit: 20000 - (8 * 100 + 500) };
    expect(() => validateFreightEntry(bag)).not.toThrow();
  });
  it('rejects mismatched totalReimbursed', () => {
    expect(() => validateFreightEntry({ ...good, totalReimbursed: 1 })).toThrowError(/totalReimbursed/);
  });
  it('rejects mismatched totalCost (units = bags for self-lifting)', () => {
    const bag = { ...good, basis: 'bag' as const, totalCost: 999 };
    expect(() => validateFreightEntry(bag)).toThrowError(/totalCost/);
  });
  it('rejects mismatched profit', () => {
    expect(() => validateFreightEntry({ ...good, profit: 0 })).toThrowError(/profit/);
  });
  it('tolerates ≤0.01 rounding drift (tolerance rule)', () => {
    expect(() => validateFreightEntry({ ...good, totalCost: good.totalCost + 0.005 })).not.toThrow();
  });
  it('gradeBags summing to bags passes; mismatched sum → 422', () => {
    expect(() => validateFreightEntry({ ...good, gradeBags: { g1: 60, g2: 40 } })).not.toThrow();
    try {
      validateFreightEntry({ ...good, gradeBags: { g1: 60, g2: 41 } } as any);
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).status).toBe(422);
      expect((e as AppError).code).toBe('BUSINESS_RULE_VIOLATION');
    }
  });
  it('empty gradeBags map means "no split recorded" — allowed', () => {
    expect(() => validateFreightEntry({ ...good, gradeBags: {} })).not.toThrow();
  });
});

describe('validateScheme (§5.5)', () => {
  const base = {
    kind: 'fixed' as const, period: 'monthly' as const, qtyUnit: 'bag' as const,
    valueType: 'perBag' as const, slabs: [{ from: 0, value: 5 }], active: true,
  };
  it('accepts a valid fixed monthly scheme', () => expect(() => validateScheme(base)).not.toThrow());
  it('rejects active scheme with empty slabs', () => {
    expect(() => validateScheme({ ...base, slabs: [] })).toThrowError(/slab/i);
  });
  it('inactive scheme may keep empty slabs (history)', () => {
    expect(() => validateScheme({ ...base, slabs: [], active: false })).not.toThrow();
  });
  it('rejects duplicate slab from', () => {
    expect(() =>
      validateScheme({ ...base, slabs: [{ from: 5, value: 1 }, { from: 5, value: 2 }] }),
    ).toThrowError(/duplicate/i);
  });
  it('variable needs windowFrom ≤ windowTo', () => {
    expect(() => validateScheme({ ...base, kind: 'variable', period: null, windowFrom: null, windowTo: '2026-08-01' })).toThrowError(/window/);
    expect(() => validateScheme({ ...base, kind: 'variable', period: null, windowFrom: '2026-08-15', windowTo: '2026-08-01' })).toThrowError(/window/);
    expect(() => validateScheme({ ...base, kind: 'variable', period: null, windowFrom: '2026-08-01', windowTo: '2026-08-15' })).not.toThrow();
  });
  it('fixed/mix need a period', () => {
    expect(() => validateScheme({ ...base, period: null })).toThrowError(/period/);
    expect(() => validateScheme({ ...base, kind: 'mix', period: null, premiumGradeIds: ['g1'] })).toThrowError(/period/);
  });
  it('mix needs premium grades and non-negative gate', () => {
    expect(() => validateScheme({ ...base, kind: 'mix', premiumGradeIds: [] })).toThrowError(/premium grade/i);
    expect(() => validateScheme({ ...base, kind: 'mix', premiumGradeIds: ['g1'], minPremiumQty: 10 })).not.toThrow();
  });
});

describe('validateClaim / validatePurchase (§5.5)', () => {
  it('claim: accrued ≥ 0 and periodFrom ≤ periodTo', () => {
    expect(() => validateClaim({ accrued: 0, periodFrom: '2026-08-01', periodTo: '2026-08-31' })).not.toThrow();
    expect(() => validateClaim({ accrued: -1, periodFrom: '2026-08-01', periodTo: '2026-08-31' })).toThrowError(/accrued/);
    expect(() => validateClaim({ accrued: 0, periodFrom: '2026-09-01', periodTo: '2026-08-31' })).toThrowError(/periodFrom/);
  });
  it('purchase: qty > 0, ratePerBag ≥ 0', () => {
    expect(() => validatePurchase({ qty: 1, ratePerBag: 0 })).not.toThrow();
    expect(() => validatePurchase({ qty: 0, ratePerBag: 10 })).toThrowError(/> 0/);
    expect(() => validatePurchase({ qty: 1, ratePerBag: -1 })).toThrowError(/>= 0/);
  });
});

describe('sortSlabs (§3.9)', () => {
  it('sorts ascending and is stable/no-mutation', () => {
    const input = [{ from: 20, value: 3 }, { from: 0, value: 1 }, { from: 5, value: 2 }];
    const out = sortSlabs(input);
    expect(out.map((s) => s.from)).toEqual([0, 5, 20]);
    expect(input[0].from).toBe(20); // original untouched
  });
});

describe('claimAutoStatus (§5.4 mirror of ClaimsNotifier.updateClaim)', () => {
  const base = { accrued: 100, sentOn: null as string | null };
  it('→ received when fully covered with ≥1 credit note', () => {
    expect(claimAutoStatus({ ...base, status: 'claimed', receivedAmount: 100, hasCreditNotes: true })).toBe('received');
    expect(claimAutoStatus({ ...base, status: 'claimable', receivedAmount: 150, hasCreditNotes: true })).toBe('received');
  });
  it('no credit notes → never received', () => {
    expect(claimAutoStatus({ ...base, status: 'claimed', receivedAmount: 1000, hasCreditNotes: false })).toBe('claimed');
  });
  it('falls off received when coverage is removed', () => {
    expect(claimAutoStatus({ ...base, status: 'received', receivedAmount: 50, hasCreditNotes: true })).toBe('claimable');
    expect(claimAutoStatus({ ...base, status: 'received', receivedAmount: 50, hasCreditNotes: true, sentOn: '2026-08-01' })).toBe('claimed');
  });
  it('1e-9 epsilon on full coverage', () => {
    // just inside the epsilon (accrued - 5e-10) → received
    expect(claimAutoStatus({ ...base, status: 'claimed', receivedAmount: 100 - 5e-10, hasCreditNotes: true })).toBe('received');
    // clearly below (accrued - 5e-9) → stays claimed
    expect(claimAutoStatus({ ...base, status: 'claimed', receivedAmount: 99.999999995, hasCreditNotes: true })).toBe('claimed');
  });
});
