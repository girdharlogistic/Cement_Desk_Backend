import { createSign } from 'crypto';
import { readFileSync } from 'fs';

/**
 * OAuth2 access tokens for a Google service account, hand-rolled with node's
 * own crypto rather than google-auth-library: it is thirty lines against a
 * dependency tree, and this server already hand-rolls its JWTs elsewhere.
 *
 * Shared between FCM and the Play Developer API, which differ only in scope.
 */

export interface ServiceAccount {
  project_id?: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** Thrown for anything Google or the key file did wrong. Callers map this to
 *  an AppError with the wording their feature wants. */
export class GoogleSaError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'GoogleSaError';
  }
}

// Keyed by file path / path+scope: a process may hold two accounts (Firebase
// and Play are the same key here, but the console key need not be).
const accounts = new Map<string, ServiceAccount>();
const tokens = new Map<string, { value: string; expiresAt: number }>();

export function loadServiceAccount(path: string): ServiceAccount {
  const hit = accounts.get(path);
  if (hit) return hit;
  let parsed: ServiceAccount;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new GoogleSaError(`Could not read the service-account key at ${path}.`);
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new GoogleSaError(`The service-account key at ${path} is missing required fields.`);
  }
  accounts.set(path, { ...parsed, token_uri: parsed.token_uri || 'https://oauth2.googleapis.com/token' });
  return accounts.get(path)!;
}

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Cached because a token is good for an hour and minting one is an RSA
 * signature plus a round trip to Google. Refreshed a minute early so a request
 * cannot set out with a token that expires in flight.
 */
export async function googleAccessToken(keyPath: string, scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const cacheKey = `${keyPath}:${scope}`;
  const cached = tokens.get(cacheKey);
  if (cached && cached.expiresAt > now + 60) return cached.value;

  const key = loadServiceAccount(keyPath);
  const tokenUri = key.token_uri!;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope,
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const assertion = `${header}.${claims}.${b64url(signer.sign(key.private_key))}`;

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!res.ok || !json.access_token) {
    throw new GoogleSaError(`Google refused the service-account assertion.`, res.status);
  }
  tokens.set(cacheKey, { value: json.access_token, expiresAt: now + (json.expires_in ?? 3600) });
  return json.access_token;
}

/** Test helper — drops the memoised keys and tokens. */
export function _resetGoogleSaForTests(): void {
  accounts.clear();
  tokens.clear();
}
