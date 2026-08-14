/**
 * Numeric helpers. MySQL returns DECIMAL as strings (mysql2 dateStrings/decimals
 * default) — convert at the boundary. Wire format uses JSON numbers (§11.1).
 * Values in this domain are far below Number.MAX_SAFE_INTEGER, so Number is fine
 * for comparison as long as we compare with the spec's 0.01 tolerance (§5.5).
 */

export function num(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n) || !Number.isFinite(n)) return 0;
  return n;
}

/** Wire conversion for DECIMAL columns: always a JSON number. */
export function dec(v: unknown): number {
  return num(v);
}

export const EPS = 0.01;

export function approxEq(a: number, b: number, eps = EPS): boolean {
  return Math.abs(a - b) <= eps;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
