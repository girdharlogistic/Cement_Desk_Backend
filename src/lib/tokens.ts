import { createHash, randomBytes } from 'crypto';
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { getConfig } from '../config';
import { errors, AppError } from './errors';
import { newId } from './ids';

function secret(): Uint8Array {
  return new TextEncoder().encode(getConfig().JWT_SECRET);
}

export type AccessClaims = { sub: string; sid: string };

export async function signAccessToken(userId: string, sessionId: string): Promise<string> {
  const ttl = getConfig().ACCESS_TOKEN_TTL_SECONDS;
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .setJti(newId())
    .sign(secret());
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, secret());
    if (!payload.sub || typeof payload.sid !== 'string') throw new Error('bad claims');
    return { sub: payload.sub, sid: payload.sid };
  } catch (e) {
    if (e instanceof joseErrors.JWTExpired) throw errors.tokenExpired();
    if (e instanceof AppError) throw e;
    throw errors.unauthenticated('Invalid access token');
  }
}

/** Opaque 32-byte refresh token, base64url on the wire, sha256 hex at rest (§7.2). */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256Hex(token) };
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Opaque token for email verification / password reset / invites. */
export function generateAuthToken(): { token: string; hash: string } {
  return generateRefreshToken();
}
