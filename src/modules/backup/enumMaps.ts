/** §11.2 legacy int ↔ wire-string enum mapping (local JSON backup stores indexes). */

export const ENUM_TABLES = {
  CostBasis: ['km', 'bag'],
  SourceType: ['plant', 'depot'],
  SchemeKind: ['fixed', 'variable', 'mix', 'cash'],
  SchemePeriod: ['monthly', 'quarterly', 'annual'],
  QtyUnit: ['bag', 'mt'],
  ValueType: ['perBag', 'perMt', 'percent'],
  ClaimStatus: ['claimable', 'claimed', 'received'],
} as const;

export type EnumName = keyof typeof ENUM_TABLES;

/**
 * Import direction: accepts a legacy index, the wire string, or null/undefined
 * (then falls back to `def`, e.g. Scheme.minPremiumUnit defaults to index 1 = 'mt' — §11.2 trap).
 */
export function enumFromLegacy<T extends string>(name: EnumName, v: unknown, def?: T): T | null {
  const table = ENUM_TABLES[name] as readonly string[];
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < table.length) return table[v] as T;
  if (typeof v === 'string' && (table as readonly string[]).includes(v)) return v as T;
  return (def ?? null) as T | null;
}

/** Export direction: wire string → legacy index (null stays null). */
export function enumToLegacy(name: EnumName, v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const idx = (ENUM_TABLES[name] as readonly string[]).indexOf(String(v));
  return idx >= 0 ? idx : null;
}
