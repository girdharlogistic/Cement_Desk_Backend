import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Brevo is switched off under vitest unless this is set, so no other test can
// spend the domain's quota. Only this file opts in, and fetch is mocked here —
// nothing leaves the machine.
process.env.MAILER_TEST_ALLOW_BREVO = '1';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-0123456789';
process.env.BREVO_API_KEY = 'xkeysib-test';
process.env.BREVO_DAILY_LIMIT = '2';
process.env.SMTP_HOST = 'smtp.test.invalid';
process.env.SMTP_USER = 'backup@test.invalid';
process.env.SMTP_PASS = 'x';
delete process.env.SMTP_URL;

const smtpSend = vi.fn(async () => ({}));
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail: smtpSend }) },
}));

const { sendMail, _resetMailer } = await import('../../src/lib/mailer');

function brevoReplies(...statuses: number[]) {
  const f = vi.fn();
  for (const s of statuses) f.mockResolvedValueOnce(new Response('{}', { status: s }));
  vi.stubGlobal('fetch', f);
  return f;
}

beforeEach(() => {
  _resetMailer();
  smtpSend.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('mailer: Brevo first, SMTP as backup', () => {
  it('sends through Brevo while under the daily limit', async () => {
    const f = brevoReplies(201);
    await sendMail('a@b.c', 'Code', '123456');
    expect(f).toHaveBeenCalledTimes(1);
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.sender.email).toBe('noreply@girdharlogistics.in');
    expect(body.to).toEqual([{ email: 'a@b.c' }]);
    expect(body.textContent).toBe('123456');
    expect(smtpSend).not.toHaveBeenCalled();
  });

  it('switches to SMTP once the daily limit is used up', async () => {
    const f = brevoReplies(201, 201);
    for (let i = 0; i < 3; i++) await sendMail('a@b.c', 'Code', String(i));
    expect(f).toHaveBeenCalledTimes(2);
    expect(smtpSend).toHaveBeenCalledTimes(1);
  });

  it('a Brevo refusal (quota) falls back and closes Brevo for the day', async () => {
    const f = brevoReplies(402);
    await sendMail('a@b.c', 'Code', '1');
    await sendMail('a@b.c', 'Code', '2');
    expect(f).toHaveBeenCalledTimes(1);
    expect(smtpSend).toHaveBeenCalledTimes(2);
  });

  it('a Brevo outage diverts only that one mail', async () => {
    const f = brevoReplies(503, 201);
    await sendMail('a@b.c', 'Code', '1');
    await sendMail('a@b.c', 'Code', '2');
    expect(f).toHaveBeenCalledTimes(2);
    expect(smtpSend).toHaveBeenCalledTimes(1);
  });
});
