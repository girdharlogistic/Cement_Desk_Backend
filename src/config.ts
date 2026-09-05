import { z } from 'zod';

// Load .env if present (Node >= 20.12 native; no dependency).
try {
  (process as any).loadEnvFile?.('.env');
} catch {
  /* no .env file — fine */
}

const EnvSchema = z.object({
  /**
   * The database file. SQLite since 2026-09-05, replacing TiDB Cloud — its
   * free tier's request-unit ceiling had become the binding constraint on a
   * dataset of a few thousand rows.
   *
   * Deliberately outside the repo, like CONSOLE_MEDIA_DIR: a `git clean` must
   * not be able to delete the books. The directory is created at boot if it is
   * not there, and the WAL and shared-memory files live beside it.
   */
  SQLITE_PATH: z.string().min(1).default('/home/ubuntu/cementdesk-data/cementdesk.db'),

  /**
   * Where the nightly `VACUUM INTO` snapshots go, and how many to keep. Empty
   * disables them. This matters more than it did on TiDB: nothing replicates
   * this file any more, so a backup is the only copy that is not on one disk.
   */
  SQLITE_BACKUP_DIR: z.string().default(''),
  SQLITE_BACKUP_KEEP: z.coerce.number().int().min(1).max(365).default(14),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().default(15 * 60),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().default(60 * 24 * 3600),
  ARGON2_MEMORY_KB: z.coerce.number().int().default(65536),
  ARGON2_ITERATIONS: z.coerce.number().int().default(3),

  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),

  TOMBSTONE_RETENTION_DAYS: z.coerce.number().int().default(180),
  ENABLE_JOBS: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  // ---- Google Play billing ----
  // The service account is the same one the release workflow uses. It needs
  // the "View financial data" permission in Play Console on top of releasing,
  // or every purchase check comes back 401.
  //
  // A path rather than the JSON inline: the key is a multi-line PEM and .env
  // is not the place for it. The file is mode 600 and matched by .gitignore's
  // `*service-account*.json`.
  PLAY_SA_KEY_FILE: z.string().default(''),
  PLAY_PACKAGE_NAME: z.string().default('com.girdharlogistics.cementdesk'),
  /** The one subscription product. Base plans `monthly` and `yearly` hang off it. */
  PLAY_PRODUCT_ID: z.string().default('premium'),

  /**
   * Whether a missing entitlement actually *blocks* anything.
   *
   * False until a real purchase has been put through end to end. Flipping it
   * on is what starts limiting free accounts to one writable firm and one
   * device — do that before it is proven and the users who already have four
   * firms are locked out by a bug rather than by a decision.
   */
  BILLING_ENFORCED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  /**
   * Shared secret on the Pub/Sub push endpoint for Play's Real-time Developer
   * Notifications. Empty disables the endpoint rather than leaving an
   * unauthenticated route that can rewrite entitlements.
   */
  PLAY_RTDN_SECRET: z.string().default(''),

  // ---- notification console (/console) ----
  // A login of its own, deliberately unrelated to any app account: this page
  // can push a notification to every install, and no firm role should ever
  // imply that. Leave CONSOLE_PASSWORD_HASH empty and the console is off.
  CONSOLE_EMAIL: z.string().default(''),
  /** argon2 hash. The password itself is never stored anywhere. */
  CONSOLE_PASSWORD_HASH: z.string().default(''),
  CONSOLE_SESSION_TTL_SECONDS: z.coerce.number().int().default(8 * 3600),
  /** Service-account JSON with permission to send to the Firebase project. */
  FCM_KEY_PATH: z.string().default(''),
  FCM_TOPIC: z.string().default('all'),
  /** Where uploaded notification images are written — outside the repo. */
  CONSOLE_MEDIA_DIR: z.string().default(''),
  /**
   * Origin images are served from. Google's servers fetch the image, not the
   * phone, so this has to be the public URL: a localhost one yields a
   * notification whose picture is silently missing.
   */
  PUBLIC_BASE_URL: z.string().default(''),

  SMTP_URL: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('Cement Desk <no-reply@cementdesk.local>'),
  DEV_MAIL_LOG: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
});

export type Config = z.infer<typeof EnvSchema>;

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // Fail fast at boot if required env is missing (§13.1).
    throw new Error(`Invalid configuration — fix environment:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: force re-parse with explicit env overrides. */
export function _resetConfigForTests(): void {
  cached = null;
}
