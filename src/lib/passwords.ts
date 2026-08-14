import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { getConfig } from '../config';

/** argon2id per spec §7.1: memory >= 64MB, iterations >= 3, parallelism 1. */
export async function hashPassword(password: string): Promise<string> {
  const cfg = getConfig();
  return argonHash(password, {
    memoryCost: cfg.ARGON2_MEMORY_KB,
    timeCost: cfg.ARGON2_ITERATIONS,
    parallelism: 1,
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(hash, password);
  } catch {
    return false;
  }
}

/** Dummy hash to equalize timing on login with unknown email (account-enumeration defence). */
export const DUMMY_HASH_PROMISE = () =>
  argonHash('dummy-password-for-timing', { memoryCost: 65536, timeCost: 3, parallelism: 1 });
