import nodemailer, { Transporter } from 'nodemailer';
import { getConfig } from '../config';

/**
 * Real mail delivery. Config resolution order:
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

export function mailConfigured(): boolean {
  return getTransporter() !== null;
}

export async function sendMail(to: string, subject: string, body: string): Promise<void> {
  const cfg = getConfig();
  const t = getTransporter();
  if (!t) {
    // Dev/test fallback only. Token-bearing bodies hit logs only when DEV_MAIL_LOG.
    console.log(`[mail] (no SMTP configured, not delivered) to=${to} subject=${subject}`);
    if (cfg.DEV_MAIL_LOG) console.log(`[mail] body=${body}`);
    return;
  }
  await t.sendMail({ from: cfg.MAIL_FROM, to, subject, text: body });
}
