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

/**
 * Dummy hash to equalize timing on login with an unknown email (account-enumeration
 * defence). Computed once and memoized: deriving it per request would double the
 * argon2 work — 64 MB and ~100 ms extra on *every* login, including successful ones,
 * which is a cheap way to hand an attacker a memory-exhaustion lever.
 */
let dummyHash: Promise<string> | null = null;
export const DUMMY_HASH_PROMISE = (): Promise<string> => {
  dummyHash ??= argonHash('dummy-password-for-timing', {
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
  return dummyHash;
};
