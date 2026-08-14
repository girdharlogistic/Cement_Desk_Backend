import { describe, it, expect } from 'vitest';
import { parseBusinessDate, nowSql, sqlToIso, isoToSql, addSecondsSql } from '../../src/lib/dates';

// §15.1: date handling must be identical under any server TZ. parseBusinessDate
// is string-based (no JS Date in the business-date path), so these tests are
// TZ-independent by construction.
describe('parseBusinessDate (§5.7)', () => {
  it('accepts yyyy-MM-dd', () => {
    expect(parseBusinessDate('2026-08-14')).toBe('2026-08-14');
  });
  it('accepts local-midnight ISO without offset (client toIso8601String)', () => {
    expect(parseBusinessDate('2026-08-14T00:00:00.000')).toBe('2026-08-14');
    expect(parseBusinessDate('2026-02-28T13:45:12')).toBe('2026-02-28');
  });
  it('takes the date part literally when an offset/Z is present — no TZ conversion', () => {
    // A literal "14 August" must stay 14 August — even if the string has a zone.
    expect(parseBusinessDate('2026-08-14T23:30:00+05:30')).toBe('2026-08-14');
    expect(parseBusinessDate('2026-08-14T23:30:00Z')).toBe('2026-08-14');
  });
  it('rejects impossible calendar days', () => {
    expect(parseBusinessDate('2026-02-30')).toBeNull();
    expect(parseBusinessDate('2025-02-29')).toBeNull(); // not a leap year
    expect(parseBusinessDate('2024-02-29')).toBe('2024-02-29'); // leap year ok
  });
  it('rejects out-of-range corruption (§5.7 bounds)', () => {
    expect(parseBusinessDate('1999-12-31')).toBeNull();
    expect(parseBusinessDate('2100-01-01')).toBeNull();
    expect(parseBusinessDate('2000-01-01')).toBe('2000-01-01');
  });
  it('rejects garbage', () => {
    expect(parseBusinessDate('14-08-2026')).toBeNull();
    expect(parseBusinessDate('August 14')).toBeNull();
    expect(parseBusinessDate('')).toBeNull();
    expect(parseBusinessDate(null)).toBeNull();
    expect(parseBusinessDate(20260814)).toBeNull();
  });
});

describe('audit timestamps (DATETIME(3) UTC)', () => {
  it('nowSql formats UTC with milliseconds', () => {
    const s = nowSql(new Date(Date.UTC(2026, 7, 14, 9, 12, 33, 412)));
    expect(s).toBe('2026-08-14 09:12:33.412');
  });
  it('sqlToIso ⇄ isoToSql round-trip', () => {
    const sql = '2026-08-14 09:12:33.412';
    const iso = sqlToIso(sql);
    expect(iso).toBe('2026-08-14T09:12:33.412Z');
    expect(isoToSql(iso)).toBe(sql);
  });
  it('isoToSql rejects garbage', () => {
    expect(isoToSql('nope')).toBeNull();
    expect(isoToSql(null)).toBeNull();
  });
  it('addSecondsSql is exact', () => {
    const s = addSecondsSql(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)), 90);
    expect(s).toBe('2026-01-01 00:01:30.000');
  });
});
