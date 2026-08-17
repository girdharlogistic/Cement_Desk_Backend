import { describe, expect, it } from 'vitest';
import {
  generateOtp,
  hashOtp,
  isOtpShaped,
  otpMatches,
  OTP_LENGTH,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_SECONDS,
} from '../../src/lib/otp';

describe('otp', () => {
  it('generates a zero-padded code of exactly OTP_LENGTH digits', () => {
    for (let i = 0; i < 500; i++) {
      const { code } = generateOtp();
      expect(code).toHaveLength(OTP_LENGTH);
      expect(isOtpShaped(code)).toBe(true);
    }
  });

  it('gives every code its own salt', () => {
    const salts = new Set(Array.from({ length: 200 }, () => generateOtp().salt));
    expect(salts.size).toBe(200);
  });

  it('hashes the same code differently under different salts', () => {
    // The point of the salt: a leaked hash must not be reversible with a table
    // of all one million sha256('000000'..'999999') digests.
    expect(hashOtp('123456', 'aaaa')).not.toBe(hashOtp('123456', 'bbbb'));
  });

  it('accepts the right code and rejects everything else', () => {
    const { code, salt, hash } = generateOtp();
    expect(otpMatches(code, salt, hash)).toBe(true);

    const wrong = String((Number(code) + 1) % 1_000_000).padStart(OTP_LENGTH, '0');
    expect(otpMatches(wrong, salt, hash)).toBe(false);
    // Right code, wrong salt — i.e. a code replayed against another row.
    expect(otpMatches(code, 'deadbeef', hash)).toBe(false);
  });

  it('rejects malformed codes without throwing', () => {
    const { salt, hash } = generateOtp();
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 456']) {
      expect(isOtpShaped(bad)).toBe(false);
      expect(otpMatches(bad, salt, hash)).toBe(false);
    }
  });

  it('keeps the guess budget small enough to matter', () => {
    // 5 tries against a million codes is 1-in-200,000 per issued code. If
    // either number drifts, the whole scheme's security changes — so pin them.
    expect(OTP_MAX_ATTEMPTS).toBeLessThanOrEqual(5);
    expect(OTP_TTL_SECONDS).toBeLessThanOrEqual(15 * 60);
  });
});
