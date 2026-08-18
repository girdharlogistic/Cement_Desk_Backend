import { createSign } from 'crypto';
import { readFileSync } from 'fs';
import { getConfig } from '../../config';
import { errors } from '../../lib/errors';

/**
 * Firebase Cloud Messaging, HTTP v1.
 *
 * Delivery is by topic — the app subscribes every install to one on startup —
 * so there is no device list here and no per-user bookkeeping. One request
 * reaches every phone that has the app.
 *
 * The OAuth assertion is signed with node's own crypto rather than
 * google-auth-library: it is thirty lines against a dependency tree, and this
 * server already hand-rolls its JWTs elsewhere.
 */

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri: string;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

let account: ServiceAccount | null = null;

function serviceAccount(): ServiceAccount {
  if (account) return account;
  const path = getConfig().FCM_KEY_PATH;
  if (!path) throw errors.validation('Notifications are not configured (FCM_KEY_PATH).');
  let parsed: ServiceAccount;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw errors.validation(`Could not read the Firebase key at ${path}.`);
  }
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw errors.validation('The Firebase key file is missing required fields.');
  }
  account = parsed;
  return account;
}

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Cached because a token is good for an hour and minting one is an RSA
 * signature plus a round trip to Google. Refreshed a minute early so a request
 * cannot set out with a token that expires in flight.
 */
let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.value;

  const key = serviceAccount();
  const tokenUri = key.token_uri || 'https://oauth2.googleapis.com/token';
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope: SCOPE,
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
    throw errors.validation(`Firebase refused the service-account key (${res.status}).`);
  }
  cachedToken = { value: json.access_token, expiresAt: now + (json.expires_in ?? 3600) };
  return cachedToken.value;
}

export interface SendInput {
  title: string;
  body: string;
  /** Public HTTPS URL. Google fetches this, so it must be reachable from outside. */
  imageUrl?: string;
  /** Runs the whole request through FCM and drops it instead of delivering. */
  validateOnly?: boolean;
}

export async function sendToTopic(input: SendInput): Promise<string> {
  const cfg = getConfig();
  const key = serviceAccount();

  const message: Record<string, unknown> = {
    topic: cfg.FCM_TOPIC,
    // A `notification` block rather than `data`: this is what lets Android
    // post the message on its own with the app closed. A data-only payload
    // needs the app running to display anything.
    notification: { title: input.title, body: input.body },
    android: {
      // These are rare, deliberate broadcasts rather than chatter, so waking a
      // dozing device is worth the battery.
      priority: 'HIGH',
      notification: {
        channel_id: 'cement_desk_updates',
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
        ...(input.imageUrl ? { image: input.imageUrl } : {}),
      },
    },
  };

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${key.project_id}/messages:send`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        input.validateOnly ? { validate_only: true, message } : { message },
      ),
    },
  );
  const json = (await res.json().catch(() => ({}))) as { name?: string; error?: { message?: string } };
  if (!res.ok) {
    throw errors.validation(`Firebase refused it (${res.status}): ${json.error?.message ?? 'unknown error'}`);
  }
  return json.name ?? '';
}

/** Test helper — drops the memoised key and token. */
export function _resetFcmForTests(): void {
  account = null;
  cachedToken = null;
}
