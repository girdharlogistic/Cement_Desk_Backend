import { describe, expect, it } from 'vitest';
import {
  FREE_TIER,
  UNLIMITED,
  bestLimit,
  parseFeatures,
  withinLimit,
} from '../../src/modules/plans/features';

describe('parseFeatures', () => {
  it('reads a well-formed blob', () => {
    expect(parseFeatures({ adFree: true, excelExport: true, maxFirms: 5, maxDevices: 3 })).toEqual({
      adFree: true,
      excelExport: true,
      maxFirms: 5,
      maxDevices: 3,
    });
  });

  it('accepts the JSON string the database hands back', () => {
    expect(parseFeatures('{"adFree":true,"excelExport":false,"maxFirms":-1,"maxDevices":2}')).toEqual({
      adFree: true,
      excelExport: false,
      maxFirms: UNLIMITED,
      maxDevices: 2,
    });
  });

  it('falls back to the free tier for every kind of rubbish', () => {
    // A row written by a newer build, hand-edited into nonsense, or missing
    // entirely must never throw — this feeds the app's paywall screen.
    for (const bad of [null, undefined, 'not json', '[]', 42, {}, { maxFirms: 'lots' }]) {
      expect(parseFeatures(bad)).toEqual(FREE_TIER);
    }
  });

  it('keeps the keys it understands and ignores the rest', () => {
    // An older backend reading a plan a newer console wrote.
    expect(parseFeatures({ adFree: true, somethingNew: 'x' })).toEqual({
      ...FREE_TIER,
      adFree: true,
    });
  });

  it('refuses a limit below -1 rather than storing it', () => {
    expect(parseFeatures({ maxFirms: -7 }).maxFirms).toBe(FREE_TIER.maxFirms);
  });
});

describe('bestLimit', () => {
  it('takes the larger', () => {
    expect(bestLimit(1, 3)).toBe(3);
    expect(bestLimit(5, 2)).toBe(5);
  });

  it('treats unlimited as larger than any number, from either side', () => {
    expect(bestLimit(UNLIMITED, 99)).toBe(UNLIMITED);
    expect(bestLimit(99, UNLIMITED)).toBe(UNLIMITED);
  });

  it('never drops a grandfathered user below what they had', () => {
    // The free tier is one firm; somebody who had four keeps four, whether
    // they subscribe, lapse, or never pay.
    expect(bestLimit(FREE_TIER.maxFirms, 4)).toBe(4);
  });
});

describe('withinLimit', () => {
  it('allows one more while under the limit', () => {
    expect(withinLimit(1, 0)).toBe(true);
    expect(withinLimit(1, 1)).toBe(false);
    expect(withinLimit(3, 2)).toBe(true);
  });

  it('always allows more when unlimited', () => {
    expect(withinLimit(UNLIMITED, 9999)).toBe(true);
  });
});
