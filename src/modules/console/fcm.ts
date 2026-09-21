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
 * The web app joins the same topic, but it cannot do it for itself: the JS SDK
 * has no `subscribeToTopic`, and the Flutter plugin throws on the web saying
 * so. The browser can only mint a registration token. So it hands that token
 * to us and [subscribeTokenToTopic] does the join server-side, which is the
 * one thing that keeps the delivery model intact — the console still sends one
 * message to one topic and reaches phones and browsers alike. Note what this
 * deliberately is *not*: a token table. Nothing is stored. A token that has
 * gone stale is dropped by Google, and the app re-subscribes on every launch,
 * exactly as the Android side re-subscribes on every launch.
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

/**
 * The public origin, for the absolute URLs a web notification needs. Falls
 * back to the deployed host: PUBLIC_BASE_URL is only set where notification
 * images are used, and a notification with no icon is a worse failure than a
 * hard-coded default that has been right since this server existed.
 */
function webBase(): string {
  const configured = getConfig().PUBLIC_BASE_URL.replace(/\/+$/, '');
  return configured || 'https://cementdesk.sallytion.qzz.io';
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
    // The browser's half of the same message. Without this a web subscriber
    // still gets the notification — the top-level `notification` block is
    // enough for the service worker to render one — but it would carry no icon
    // and clicking it would do nothing. `link` is what opens the app, and it
    // has to be absolute and https.
    webpush: {
      headers: { Urgency: 'high', TTL: '86400' },
      notification: {
        title: input.title,
        body: input.body,
        icon: `${webBase()}/app/icons/icon-192.png`,
        badge: `${webBase()}/app/icons/favicon-48.png`,
        ...(input.imageUrl ? { image: input.imageUrl } : {}),
      },
      fcm_options: { link: `${webBase()}/app/` },
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

/**
 * Joins one registration token to the broadcast topic.
 *
 * This is the Instance ID API, not FCM v1 — there is no v1 equivalent for
 * topic management, and the `access_token_auth` header is what tells it to
 * accept an OAuth bearer instead of the legacy server key it was built for.
 *
 * Idempotent: subscribing a token that is already on the topic answers 200 and
 * changes nothing, which is what lets the app call this on every launch
 * without us keeping track of who has already called it.
 */
export async function subscribeTokenToTopic(token: string): Promise<void> {
  const topic = getConfig().FCM_TOPIC;
  const res = await fetch(
    `https://iid.googleapis.com/iid/v1/${encodeURIComponent(token)}/rel/topics/${encodeURIComponent(topic)}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        access_token_auth: 'true',
        'content-type': 'application/json',
      },
    },
  );
  if (res.ok) return;
  const body = await res.text().catch(() => '');
  // 400 here means the token is malformed or belongs to another Firebase
  // project — a client problem, not an outage, and not worth a retry.
  if (res.status === 400 || res.status === 404) {
    throw errors.validation('That push token was rejected by Firebase.');
  }
  throw errors.validation(`Firebase refused the subscription (${res.status}): ${body.slice(0, 200)}`);
}

/** Test helper — drops the memoised key and token. */
export function _resetFcmForTests(): void {
  account = null;
  _resetGoogleSaForTests();
}
