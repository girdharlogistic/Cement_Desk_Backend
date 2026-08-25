import { getConfig } from '../../config';
import { errors } from '../../lib/errors';
import {
  GoogleSaError,
  ServiceAccount,
  _resetGoogleSaForTests,
  googleAccessToken,
  loadServiceAccount,
} from '../../lib/google_sa';

/**
 * Firebase Cloud Messaging, HTTP v1.
 *
 * Delivery is by topic — the app subscribes every install to one on startup —
 * so there is no device list here and no per-user bookkeeping. One request
 * reaches every phone that has the app.
 *
 * The OAuth lives in lib/google_sa, shared with the Play Developer API.
 */

interface FirebaseAccount extends ServiceAccount {
  project_id: string;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

let account: FirebaseAccount | null = null;

function serviceAccount(): FirebaseAccount {
  if (account) return account;
  const path = getConfig().FCM_KEY_PATH;
  if (!path) throw errors.validation('Notifications are not configured (FCM_KEY_PATH).');
  let parsed: ServiceAccount;
  try {
    parsed = loadServiceAccount(path);
  } catch (e) {
    // Same wording this module always had, just sourced from the shared key loader.
    if (e instanceof GoogleSaError && e.message.includes('missing required fields')) {
      throw errors.validation('The Firebase key file is missing required fields.');
    }
    throw errors.validation(`Could not read the Firebase key at ${path}.`);
  }
  if (!parsed.project_id) {
    throw errors.validation('The Firebase key file is missing required fields.');
  }
  account = parsed as FirebaseAccount;
  return account;
}

async function accessToken(): Promise<string> {
  const path = getConfig().FCM_KEY_PATH;
  try {
    return await googleAccessToken(path, SCOPE);
  } catch (e) {
    const status = e instanceof GoogleSaError ? ` (${e.status ?? '??'})` : '';
    throw errors.validation(`Firebase refused the service-account key${status}.`);
  }
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
  _resetGoogleSaForTests();
}
