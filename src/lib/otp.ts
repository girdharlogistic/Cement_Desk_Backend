import { randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { sha256Hex } from './tokens';

/**
 * Six-digit numeric codes for email verification and password reset.
 *
 * The code itself carries almost no entropy — ~20 bits — so the security of
 * this scheme lives entirely in the policy around it, not in the digits:
 *
 *   • 10-minute lifetime, so a code is only guessable while it is live.
 *   • 5 attempts, after which the code is burned and a new one must be sent.
 *     That caps an attacker at 5 guesses per code, i.e. odds of 1 in 200,000.
 *   • Per-row salt, so the stored hash cannot be reversed with a lookup table
 *     of all one million sha256 digests.
 *   • Resend throttling at the route, so an attacker cannot mint codes faster
 *     than they can guess them.
 */
export const OTP_TTL_SECONDS = 10 * 60;
export const OTP_MAX_ATTEMPTS = 5;

/** How long the user must wait between resends, and the hourly ceiling. */
export const OTP_RESEND_COOLDOWN_SECONDS = 60;
export const OTP_RESEND_PER_HOUR = 5;

export const OTP_LENGTH = 6;

/**
 * `randomInt` rather than `randomBytes % 1e6`: the modulo of a byte range that
 * is not a multiple of a million biases the low codes, and a biased OTP is a
 * smaller keyspace than it looks.
 */
export function generateOtp(): { code: string; salt: string; hash: string } {
  const code = String(randomInt(0, 1_000_000)).padStart(OTP_LENGTH, '0');
  const salt = randomBytes(16).toString('hex');
  return { code, salt, hash: hashOtp(code, salt) };
}

export function hashOtp(code: string, salt: string): string {
  return sha256Hex(`${salt}:${code}`);
}

/** Constant-time compare, so a wrong code cannot be narrowed digit by digit. */
export function otpMatches(code: string, salt: string, expectedHash: string): boolean {
  const got = Buffer.from(hashOtp(code, salt), 'utf8');
  const want = Buffer.from(expectedHash, 'utf8');
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

/** Digits only, exactly [OTP_LENGTH] of them. */
export function isOtpShaped(code: string): boolean {
  return new RegExp(`^\\d{${OTP_LENGTH}}$`).test(code);
}
