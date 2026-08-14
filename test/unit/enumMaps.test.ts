import { describe, it, expect } from 'vitest';
import { enumFromLegacy, enumToLegacy, ENUM_TABLES } from '../../src/modules/backup/enumMaps';

// §11.2 mapping in both directions, including the minPremiumUnit default = mt trap (§15.1).

describe('enum mapping (§11.2)', () => {
  it('index → wire string for every table entry', () => {
    (Object.keys(ENUM_TABLES) as (keyof typeof ENUM_TABLES)[]).forEach((name) => {
      ENUM_TABLES[name].forEach((wire, idx) => {
        expect(enumFromLegacy(name, idx)).toBe(wire);
      });
    });
  });
  it('wire string → index round-trips', () => {
    (Object.keys(ENUM_TABLES) as (keyof typeof ENUM_TABLES)[]).forEach((name) => {
      ENUM_TABLES[name].forEach((wire, idx) => {
        expect(enumToLegacy(name, wire)).toBe(idx);
      });
    });
  });
  it('accepts the wire string on import too (idempotent for mixed payloads)', () => {
    expect(enumFromLegacy('SchemeKind', 'mix')).toBe('mix');
    expect(enumFromLegacy('CostBasis', 'bag')).toBe('bag');
  });
  it('out-of-range / null / garbage → fallback', () => {
    expect(enumFromLegacy('SchemeKind', 9)).toBeNull();
    expect(enumFromLegacy('SchemeKind', -1)).toBeNull();
    expect(enumFromLegacy('SchemeKind', 'weird')).toBeNull();
    expect(enumFromLegacy('SchemeKind', null)).toBeNull();
    expect(enumFromLegacy('SchemeKind', undefined, 'fixed')).toBe('fixed');
  });
  it('minPremiumUnit default trap: index 1 = mt (landing_models.dart)', () => {
    expect(enumFromLegacy('QtyUnit', 1)).toBe('mt');
    expect(enumFromLegacy('QtyUnit', undefined, 'mt')).toBe('mt'); // missing → mt, never bag
    expect(ENUM_TABLES.QtyUnit[1]).toBe('mt');
  });
});
