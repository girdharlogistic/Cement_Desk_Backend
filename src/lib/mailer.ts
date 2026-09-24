import nodemailer, { Transporter } from 'nodemailer';
import { getConfig } from '../config';

/**
 * Real mail delivery. Brevo (below) goes first when BREVO_API_KEY is set;
 * this SMTP transport is the backup. SMTP config resolution order:
 *   1. SMTP_URL (e.g. smtp://user:pass@smtp.gmail.com:587 or smtps://...:465)
 *   2. SMTP_HOST/SMTP_PORT/SMTP_SECURE/SMTP_USER/SMTP_PASS
 * If neither is set we fall back to log-only, and DEV_MAIL_LOG=true additionally
 * logs the *body* (tokens!) — dev-only, never enable in production.
 */
let transporter: Transporter | null | undefined;

function getTransporter(): Transporter | null {
  if (transporter !== undefined) return transporter;
  const cfg = getConfig();
  let t: Transporter | null = null;
  if (cfg.SMTP_URL) {
    t = nodemailer.createTransport(cfg.SMTP_URL);
  } else if (cfg.SMTP_HOST && cfg.SMTP_USER && cfg.SMTP_PASS) {
    t = nodemailer.createTransport({
      host: cfg.SMTP_HOST,
      port: cfg.SMTP_PORT ?? 587,
      secure: (cfg.SMTP_PORT ?? 587) === 465,
      auth: { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS },
    });
  }
  transporter = t;
  return t;
}

/**
 * Brevo, the primary sender (our own domain, 300 mails/day on the free plan).
 *
 * The day's count is kept in memory, keyed by UTC date. A restart forgets it,
 * which is why a refusal from Brevo also closes it for the rest of the day:
 * the counter saves a wasted round trip, the refusal is what actually keeps
 * mail flowing once the quota is gone — through SMTP, which is the old Gmail
 * account and still works exactly as it did before Brevo existed.
 */
const brevoDay = { day: '', sent: 0, closed: false };

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function brevoAvailable(): boolean {
  const cfg = getConfig();
  // A test run must never spend the domain's daily quota (or send real mail
  // from it to example.com addresses, which hurts its reputation).
  if (process.env.VITEST && !process.env.MAILER_TEST_ALLOW_BREVO) return false;
  if (!cfg.BREVO_API_KEY) return false;
  const today = utcDay();
  if (brevoDay.day !== today) {
    brevoDay.day = today;
    brevoDay.sent = 0;
    brevoDay.closed = false;
  }
  return !brevoDay.closed && brevoDay.sent < cfg.BREVO_DAILY_LIMIT;
}

async function sendViaBrevo(to: string, subject: string, body: string): Promise<void> {
  const cfg = getConfig();
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'api-key': cfg.BREVO_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: cfg.BREVO_SENDER_NAME, email: cfg.BREVO_SENDER_EMAIL },
      to: [{ email: to }],
      subject,
      textContent: body,
    }),
    // A hung API call would otherwise hold a signup open; SMTP is right there.
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw Object.assign(new Error(`Brevo ${res.status}: ${detail}`), { status: res.status });
  }
}

export function mailConfigured(): boolean {
  return brevoAvailable() || getTransporter() !== null;
}

export async function sendMail(to: string, subject: string, body: string): Promise<void> {
  const cfg = getConfig();
  const t = getTransporter();
  if (brevoAvailable()) {
    try {
      await sendViaBrevo(to, subject, body);
      brevoDay.sent++;
      return;
    } catch (e) {
      // Whatever went wrong, the user's OTP should still arrive, so SMTP
      // takes this one. A 4xx is Brevo refusing us — over quota (402/429) or
      // a bad key — and will keep happening, so Brevo is closed for the rest
      // of the day. A 5xx or a timeout is a blip: only this mail is diverted.
      const status = (e as { status?: number }).status;
      if (status !== undefined && status >= 400 && status < 500) brevoDay.closed = true;
      console.error(`[mail] Brevo failed, falling back to SMTP: ${(e as Error)?.message ?? e}`);
      if (!t) throw e;
    }
  }
  if (!t) {
    // Dev/test fallback only. Token-bearing bodies hit logs only when DEV_MAIL_LOG.
    console.log(`[mail] (no SMTP configured, not delivered) to=${to} subject=${subject}`);
    if (cfg.DEV_MAIL_LOG) console.log(`[mail] body=${body}`);
    return;
  }
  await t.sendMail({ from: cfg.MAIL_FROM, to, subject, text: body });
}

/** Test hook: forget the day's Brevo count and the cached SMTP transport. */
export function _resetMailer(): void {
  brevoDay.day = '';
  brevoDay.sent = 0;
  brevoDay.closed = false;
  transporter = undefined;
}

/**
 * Fire-and-forget send for paths where mail delivery must never fail the request
 * (e.g. the verification mail on signup). An unawaited `sendMail` would surface
 * an SMTP error as an unhandled rejection, which takes the process down.
 */
export function sendMailBestEffort(to: string, subject: string, body: string): void {
  void sendMail(to, subject, body).catch((e: unknown) => {
    console.error(`[mail] delivery failed to=${to} subject=${subject}: ${(e as Error)?.message ?? e}`);
  });
}
