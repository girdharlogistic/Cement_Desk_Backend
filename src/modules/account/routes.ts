import { FastifyInstance, FastifyReply } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { getConfig } from '../../config';
import { q, qOne } from '../../db/pool';
import { errors } from '../../lib/errors';
import { enforceLimit } from '../../lib/limiter';
import { verifyPassword, DUMMY_HASH_PROMISE } from '../../lib/passwords';
import { normalizeEmail } from '../auth/service';
import { deleteAccountPage } from './page';

/**
 * `/delete-account` — the public account-deletion route.
 *
 * Two steps on purpose. The first proves the person at the keyboard owns the
 * account; the second shows them, in numbers, exactly what they are about to
 * lose and makes them type their own address to go through with it. A single
 * form with a password box would be shorter and would also let somebody end
 * three years of books with one mistaken click.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DEMONSTRATION. `/delete-account/confirm` deletes nothing. It validates the
 * whole flow and returns `deleted: false` with a message saying so. Wiring the
 * real cascade in is a separate piece of work — see the note on that route.
 * ─────────────────────────────────────────────────────────────────────────
 */

const AUDIENCE = 'cement-desk-delete';

/**
 * Ten minutes. Long enough to read the page properly, short enough that a
 * confirmation token left in a browser on a shared phone is worthless by the
 * time anyone finds it.
 */
const TOKEN_TTL_SECONDS = 600;

function secret(): Uint8Array {
  return new TextEncoder().encode(getConfig().JWT_SECRET);
}

interface Summary {
  firms: number;
  parties: number;
  locations: number;
  entries: number;
  stockDays: number;
  purchases: number;
  schemes: number;
  claims: number;
  sessions: number;
  /** Other people who would lose access to firms this user owns. */
  sharedWith: number;
}

/**
 * Counts what deletion would take, so the confirmation is about this account
 * rather than a generic warning.
 *
 * Scoped to firms the user *owns*. Firms they were merely invited to are not
 * theirs to delete and are left out — losing access to someone else's books is
 * not the same event as destroying your own.
 */
export async function summarise(userId: string): Promise<Summary> {
  const firms = await q<{ id: string }>(
    `SELECT id FROM firms WHERE owner_user_id = ? AND deleted_at IS NULL`,
    [userId],
  );
  const ids = firms.map((f) => f.id);

  // Number(), like every other count below: the pool runs with
  // `supportBigNumbers`, so COUNT(*) arrives as a string and `n === 1` — which
  // is what picks "device" over "devices" on the page — would never be true.
  const sessions = await qOne<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL`,
    [userId],
  );

  const empty: Summary = {
    firms: 0,
    parties: 0,
    locations: 0,
    entries: 0,
    stockDays: 0,
    purchases: 0,
    schemes: 0,
    claims: 0,
    sessions: Number(sessions?.n ?? 0),
    sharedWith: 0,
  };
  if (!ids.length) return empty;

  // One round trip rather than eight. Each subquery is a covering count on a
  // firm-leading primary key, which is what those clustered PKs are for.
  const row = await qOne<Record<string, number>>(
    `SELECT
       (SELECT COUNT(*) FROM parties        WHERE firm_id IN (?) AND deleted_at IS NULL) AS parties,
       (SELECT COUNT(*) FROM locations      WHERE firm_id IN (?) AND deleted_at IS NULL) AS locations,
       (SELECT COUNT(*) FROM freight_entries WHERE firm_id IN (?) AND deleted_at IS NULL) AS entries,
       (SELECT COUNT(*) FROM stock_days     WHERE firm_id IN (?) AND deleted_at IS NULL) AS stockDays,
       (SELECT COUNT(*) FROM purchases      WHERE firm_id IN (?) AND deleted_at IS NULL) AS purchases,
       (SELECT COUNT(*) FROM schemes        WHERE firm_id IN (?) AND deleted_at IS NULL) AS schemes,
       (SELECT COUNT(*) FROM claims         WHERE firm_id IN (?) AND deleted_at IS NULL) AS claims,
       (SELECT COUNT(DISTINCT user_id) FROM firm_members
          WHERE firm_id IN (?) AND user_id <> ?) AS sharedWith`,
    [ids, ids, ids, ids, ids, ids, ids, ids, userId],
  );

  return {
    ...empty,
    firms: ids.length,
    parties: Number(row?.parties ?? 0),
    locations: Number(row?.locations ?? 0),
    entries: Number(row?.entries ?? 0),
    stockDays: Number(row?.stockDays ?? 0),
    purchases: Number(row?.purchases ?? 0),
    schemes: Number(row?.schemes ?? 0),
    claims: Number(row?.claims ?? 0),
    sharedWith: Number(row?.sharedWith ?? 0),
  };
}

export function registerAccountRoutes(app: FastifyInstance): void {
  const html = (reply: FastifyReply, body: string) =>
    reply
      .code(200)
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store, must-revalidate')
      .header(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      )
      .header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff')
      .send(body);

  app.get('/delete-account', async (_req, reply) => html(reply, deleteAccountPage()));

  app.post('/delete-account/verify', async (req) => {
    // Per IP. This is a password check on a public page, so it is a login form
    // in everything but name and gets a login form's budget.
    enforceLimit(`delete:verify:${req.ip}`, 8, 15 * 60_000);

    const parsed = z
      .object({ email: z.string().min(1), password: z.string().min(1) })
      .safeParse(req.body);
    if (!parsed.success) throw errors.validation('Enter your email and password.');

    const emailNorm = normalizeEmail(parsed.data.email);
    const user = await qOne<{
      id: string;
      email: string;
      password_hash: string;
      status: string;
    }>(`SELECT id, email, password_hash, status FROM users WHERE email_norm = ?`, [emailNorm]);

    // Verify against a throwaway hash when there is no such user, so a wrong
    // address and a wrong password take the same time. Otherwise this page
    // becomes a way to ask "does this person use Cement Desk?".
    const hash = user ? user.password_hash : await DUMMY_HASH_PROMISE();
    const ok = (await verifyPassword(hash, parsed.data.password)) && Boolean(user);
    if (!ok || !user || user.status !== 'active') {
      req.log.warn({ ip: req.ip }, 'delete-account sign-in refused');
      throw errors.unauthenticated('That email and password do not match.');
    }

    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
      .sign(secret());

    return { token, email: user.email, summary: await summarise(user.id) };
  });

  app.post('/delete-account/confirm', async (req) => {
    enforceLimit(`delete:confirm:${req.ip}`, 10, 15 * 60_000);

    const parsed = z
      .object({ token: z.string().min(1), email: z.string().min(1) })
      .safeParse(req.body);
    if (!parsed.success) throw errors.validation('Start again from the beginning.');

    let userId: string;
    try {
      const { payload } = await jwtVerify(parsed.data.token, secret(), { audience: AUDIENCE });
      if (typeof payload.sub !== 'string') throw new Error('no subject');
      userId = payload.sub;
    } catch {
      throw errors.unauthenticated('That took too long. Sign in again to start over.');
    }

    // The typed address is checked here as well as in the page. A confirmation
    // step that only exists in JavaScript is not a confirmation step.
    const user = await qOne<{ email_norm: string }>(
      `SELECT email_norm FROM users WHERE id = ?`,
      [userId],
    );
    if (!user || normalizeEmail(parsed.data.email) !== user.email_norm) {
      throw errors.validation('The address you typed does not match this account.');
    }

    // ─── This is where the deletion would go, and does not ────────────────
    //
    // Doing it properly is a piece of work in its own right, and doing it
    // badly is worse than not doing it:
    //
    //   • firms this user owns have to be dealt with rather than orphaned —
    //     either handed to another admin or destroyed with everything under
    //     them, and each child table (§5.6 cascades) taken in dependency order;
    //   • other members of those firms lose access and should be told;
    //   • sessions and auth_tokens must be revoked before anything else, or a
    //     phone that is mid-sync writes rows back into a half-deleted account;
    //   • the app's own sync has to cope with its firm disappearing underneath
    //     it, which today it does not;
    //   • and Play's policy wants a record of the request, plus a grace period
    //     if we choose to offer one.
    //
    // So: the flow is real, the deletion is not. Whoever picks this up should
    // replace this block and the response below together — a route that says it
    // deleted an account and did not would be the worst possible outcome here.
    req.log.info({ userId }, 'delete-account confirmed (demo — nothing deleted)');

    return {
      ok: true,
      deleted: false,
      message:
        'This page is a demonstration and is not connected to the deletion routine yet, ' +
        'so your account is exactly as it was. Everything up to this point worked: your ' +
        'password was checked and the summary you saw was read from your real books. ' +
        'To delete your account today, email us and we will do it by hand.',
    };
  });
}
