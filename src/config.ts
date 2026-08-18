import { z } from 'zod';

// Load .env if present (Node >= 20.12 native; no dependency).
try {
  (process as any).loadEnvFile?.('.env');
} catch {
  /* no .env file — fine */
}

const EnvSchema = z.object({
  TIDB_HOST: z.string().min(1),
  TIDB_PORT: z.coerce.number().int().default(4000),
  TIDB_USER: z.string().min(1),
  TIDB_PASSWORD: z.string().default(''),
  TIDB_DATABASE: z.string().min(1).default('cement_desk'),
  TIDB_TLS: z
    .string()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  DB_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(10),

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
