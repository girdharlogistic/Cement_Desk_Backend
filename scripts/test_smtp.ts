/** Ad-hoc SMTP verification (dev tool): verifies transport + sends one test mail. */
import { sendMail, mailConfigured } from '../src/lib/mailer';
import nodemailer from 'nodemailer';
import { getConfig } from '../src/config';

(async () => {
  const cfg = getConfig();
  if (!mailConfigured()) {
    console.error('SMTP not configured');
    process.exit(1);
  }
  const t = nodemailer.createTransport({
    host: cfg.SMTP_HOST,
    port: cfg.SMTP_PORT ?? 587,
    secure: (cfg.SMTP_PORT ?? 587) === 465,
    auth: { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS },
  });
  await t.verify();
  console.log('transport verify: OK (Gmail accepted credentials)');
  await sendMail(
    cfg.SMTP_USER!,
    'Cement Desk — SMTP test',
    `SMTP wiring works. Sent at ${new Date().toISOString()} from the Cement Desk backend.`,
  );
  console.log('test mail accepted by Gmail for delivery to', cfg.SMTP_USER);
})().catch((e) => {
  console.error('SMTP FAIL:', e.message ?? e);
  process.exit(1);
});
