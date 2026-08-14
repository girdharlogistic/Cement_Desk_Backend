import { errors, ErrorDetail } from './errors';
import { approxEq } from './num';

/**
 * Stored-derivative validation (§5.5). The client computes and stores outputs;
 * the server verifies them against the formulas and rejects corruption —
 * but MUST NOT silently recompute and overwrite (§4.3).
 */

export interface FreightInput {
  revenuePerBag: number;
  bags: number;
  totalReimbursed: number;
  basis: 'km' | 'bag';
  costRate: number;
  costUnits: number;
  otherExpenses: number;
  totalCost: number;
  profit: number;
  gradeBags?: Record<string, number>;
}

export function validateFreightEntry(e: FreightInput): void {
  const details: ErrorDetail[] = [];
  const units = e.basis === 'bag' ? e.bags : e.costUnits;

  if (e.bags < 0) details.push({ field: 'bags', code: 'MUST_BE_NON_NEGATIVE', message: 'Bags must be >= 0' });
  if (e.revenuePerBag < 0)
    details.push({ field: 'revenuePerBag', code: 'MUST_BE_NON_NEGATIVE', message: 'Rate must be >= 0' });
  if (e.costRate < 0) details.push({ field: 'costRate', code: 'MUST_BE_NON_NEGATIVE', message: 'Cost rate must be >= 0' });
  if (e.otherExpenses < 0)
    details.push({ field: 'otherExpenses', code: 'MUST_BE_NON_NEGATIVE', message: 'Other expenses must be >= 0' });
  if (e.costUnits < 0) details.push({ field: 'costUnits', code: 'MUST_BE_NON_NEGATIVE', message: 'Cost units must be >= 0' });

  if (!approxEq(e.totalReimbursed, e.revenuePerBag * e.bags)) {
    details.push({
      field: 'totalReimbursed',
      code: 'FORMULA_MISMATCH',
      message: 'totalReimbursed must equal revenuePerBag * bags',
    });
  }
  if (!approxEq(e.totalCost, e.costRate * units + e.otherExpenses)) {
    details.push({
      field: 'totalCost',
      code: 'FORMULA_MISMATCH',
      message: 'totalCost must equal costRate * units + otherExpenses',
    });
  }
  if (!approxEq(e.profit, e.totalReimbursed - e.totalCost)) {
    details.push({
      field: 'profit',
      code: 'FORMULA_MISMATCH',
      message: 'profit must equal totalReimbursed - totalCost',
    });
  }
  if (details.length) throw errors.validation(`Freight entry fails validation: ${details[0].message}`, details);

  // gradeBags split must sum to bags (§5.5) — 422 business rule.
  if (e.gradeBags && Object.keys(e.gradeBags).length > 0) {
    const sum = Object.values(e.gradeBags).reduce((a, b) => a + b, 0);
    if (!approxEq(sum, e.bags)) {
      throw errors.businessRule('gradeBags do not sum to bags (split must be "Matched")');
    }
  }
}

export interface SchemeInput {
  kind: 'fixed' | 'variable' | 'mix' | 'cash';
  period?: 'monthly' | 'quarterly' | 'annual' | null;
  windowFrom?: string | null;
  windowTo?: string | null;
  qtyUnit: 'bag' | 'mt';
  valueType: 'perBag' | 'perMt' | 'percent';
  premiumGradeIds?: string[];
  minPremiumQty?: number;
  minPremiumUnit?: 'bag' | 'mt'; // default mt (§11.2 trap)
  slabs: { from: number; value: number }[];
  active: boolean;
}

export function validateScheme(s: SchemeInput): void {
  const details: ErrorDetail[] = [];

  if (s.active && s.slabs.length === 0) {
    details.push({ field: 'slabs', code: 'EMPTY', message: 'Active schemes need at least one slab' });
  }
  const froms = s.slabs.map((x) => x.from);
  if (new Set(froms).size !== froms.length) {
    details.push({ field: 'slabs', code: 'DUPLICATE_FROM', message: 'Duplicate slab "from" value' });
  }
  if (s.kind === 'mix') {
    if (!s.premiumGradeIds || s.premiumGradeIds.length === 0) {
      details.push({
        field: 'premiumGradeIds',
        code: 'EMPTY',
        message: 'Mix schemes need at least one premium grade',
      });
    }
    if ((s.minPremiumQty ?? 0) < 0) {
      details.push({ field: 'minPremiumQty', code: 'NEGATIVE', message: 'minPremiumQty must be >= 0' });
    }
  }
  if (s.kind === 'variable') {
    if (!s.windowFrom || !s.windowTo) {
      details.push({ field: 'windowFrom', code: 'REQUIRED', message: 'Variable schemes need windowFrom and windowTo' });
    } else if (s.windowFrom > s.windowTo) {
      details.push({ field: 'windowFrom', code: 'RANGE', message: 'windowFrom must be <= windowTo' });
    }
  }
  if ((s.kind === 'fixed' || s.kind === 'mix') && !s.period) {
    details.push({ field: 'period', code: 'REQUIRED', message: 'Fixed/mix schemes need a period' });
  }
  if (details.length) throw errors.validation(`Scheme fails validation: ${details[0].message}`, details);
}

export function validateClaim(c: { accrued: number; periodFrom: string; periodTo: string }): void {
  const details: ErrorDetail[] = [];
  if (c.accrued < 0) details.push({ field: 'accrued', code: 'NEGATIVE', message: 'accrued must be >= 0' });
  if (c.periodFrom > c.periodTo)
    details.push({ field: 'periodFrom', code: 'RANGE', message: 'periodFrom must be <= periodTo' });
  if (details.length) throw errors.validation(`Claim fails validation: ${details[0].message}`, details);
}

export function validatePurchase(p: { qty: number; ratePerBag: number }): void {
  const details: ErrorDetail[] = [];
  if (!(p.qty > 0)) details.push({ field: 'qty', code: 'MUST_BE_POSITIVE', message: 'Qty must be > 0' });
  if (!(p.ratePerBag >= 0))
    details.push({ field: 'ratePerBag', code: 'MUST_BE_NON_NEGATIVE', message: 'ratePerBag must be >= 0' });
  if (details.length) throw errors.validation(`Purchase fails validation: ${details[0].message}`, details);
  // D4: overpayment (Σ payments > billValue) is legitimate → allow, never reject.
}

/** Slabs are stored auto-sorted ascending by `from` (§3.9 / §5.5). */
export function sortSlabs<T extends { from: number }>(slabs: T[]): T[] {
  return [...slabs].sort((a, b) => a.from - b.from);
}

/** Claim status auto-transition, mirroring ClaimsNotifier.updateClaim (§5.4). */
export function claimAutoStatus(args: {
  status: 'claimable' | 'claimed' | 'received';
  accrued: number;
  receivedAmount: number;
  hasCreditNotes: boolean;
  sentOn: string | null;
}): 'claimable' | 'claimed' | 'received' {
  if (args.receivedAmount >= args.accrued - 1e-9 && args.hasCreditNotes) return 'received';
  if (args.status === 'received') return args.sentOn ? 'claimed' : 'claimable';
  return args.status;
}
