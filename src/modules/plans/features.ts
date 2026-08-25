import { z } from 'zod';

/**
 * What a plan actually unlocks.
 *
 * Kept as data on the plan row rather than as constants in code, so retiring a
 * price or changing what it includes is a console edit and not a release.
 */
export interface Features {
  adFree: boolean;
  excelExport: boolean;
  maxFirms: number;
  maxDevices: number;
}

/** A limit of -1 is unlimited. Zero would mean "none", which is never useful. */
export const UNLIMITED = -1;

/**
 * What a user with no plan gets.
 *
 * One firm, one device, ads on, no export. Chosen against the real numbers at
 * the time: 30 of 34 accounts already had exactly one firm, so this paywall
 * takes nothing away from almost anybody — and the four who had more are
 * grandfathered in the migration rather than being asked to pay for what they
 * already had.
 */
export const FREE_TIER: Features = {
  adFree: false,
  excelExport: false,
  maxFirms: 1,
  maxDevices: 1,
};

/**
 * Reads a `features` blob from the database or the console.
 *
 * Deliberately total: anything missing or the wrong type falls back to the free
 * tier rather than throwing. A plan row written by a newer build, or edited by
 * hand into nonsense, must not be able to 500 the app's paywall screen.
 */
export function parseFeatures(raw: unknown): Features {
  const o = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!o || typeof o !== 'object') return { ...FREE_TIER };
  const r = o as Record<string, unknown>;
  return {
    adFree: bool(r.adFree, FREE_TIER.adFree),
    excelExport: bool(r.excelExport, FREE_TIER.excelExport),
    maxFirms: limit(r.maxFirms, FREE_TIER.maxFirms),
    maxDevices: limit(r.maxDevices, FREE_TIER.maxDevices),
  };
}

/** What the console may save. Mirrors [Features] and rejects nothing else. */
export const FeaturesInput = z.object({
  adFree: z.boolean(),
  excelExport: z.boolean(),
  // -1 for unlimited, otherwise a sane positive count. The upper bound is not
  // a product rule, it is a guard against a typo in the console turning into
  // "9999 firms" that nobody notices until support asks why.
  maxFirms: z.number().int().min(-1).max(500),
  maxDevices: z.number().int().min(-1).max(500),
});

/**
 * The better of two limits, treating -1 as bigger than anything.
 *
 * Used everywhere an effective limit is worked out, because a limit arrives
 * from two directions at once: the plan, and whatever the user was
 * grandfathered with. A lapse must never drop somebody below what they had.
 */
export function bestLimit(a: number, b: number): number {
  if (a === UNLIMITED || b === UNLIMITED) return UNLIMITED;
  return Math.max(a, b);
}

/** True when [count] more would still be within [limit]. */
export function withinLimit(limit: number, count: number): boolean {
  return limit === UNLIMITED || count < limit;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function limit(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) return fallback;
  if (v < -1) return fallback;
  return v;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
