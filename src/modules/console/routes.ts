import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { addDaysSql } from '../../lib/dates';
import {
  PlanInput,
  createPlan,
  deletePlan,
  getPlan,
  listPlans,
  readEntitlement,
  revokeEntitlement,
  updatePlan,
  upsertEntitlement,
} from '../plans/repo';
import { invalidateAllEntitlements, invalidateEntitlement } from '../plans/service';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { getConfig } from '../../config';
import { errors } from '../../lib/errors';
import { enforceLimit } from '../../lib/limiter';
import { verifyPassword, DUMMY_HASH_PROMISE } from '../../lib/passwords';
import { readSponsor, writeSponsor, SponsorInput } from '../sponsor/repo';
import { sendToTopic } from './fcm';
import { readStored, storeDataUrl } from './media';
import { consolePage, loginPage } from './page';
import { analytics, getUserDetail, listSubscriptions, listUsers } from './users';

/**
 * A small web console for sending push notifications, at `/console`.
 *
 * It sits outside `/api/v1` because it is a web page rather than part of the
 * API, and outside the app's auth entirely because it has nothing to do with
 * it: this page can notify every install, which is not a thing any firm role
 * should ever be able to grow into. One operator account, kept in the
 * environment, unrelated to any row in `users`.
 */

const COOKIE = 'cd_console';
const AUDIENCE = 'cement-desk-console';

function secret(): Uint8Array {
  return new TextEncoder().encode(getConfig().JWT_SECRET);
}

/** Whether the console is switched on at all. */
function enabled(): boolean {
  const cfg = getConfig();
  return Boolean(cfg.CONSOLE_EMAIL && cfg.CONSOLE_PASSWORD_HASH);
}

function readCookie(req: FastifyRequest, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function setCookie(reply: FastifyReply, value: string, maxAgeSeconds: number): void {
  // `Secure` unconditionally: the only way in is the public HTTPS tunnel, and
  // a cookie that can ride a plaintext hop is a session that can be lifted off
  // the wire.
  //
  // `Lax` rather than `Strict`. Strict withholds the cookie on a range of
  // top-level navigations — arriving from a bookmark manager, a redirect, some
  // browsers' address-bar cases — which for a page you reach by *navigating to
  // it* means being bounced back to the login form at random. It buys nothing
  // here either: the only state-changing route is a POST carrying
  // `content-type: application/json`, and Lax already withholds the cookie
  // from cross-site POSTs, so the CSRF story is unchanged.
  const bits = [
    `${COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  void reply.header('set-cookie', bits.join('; '));
}

async function currentOperator(req: FastifyRequest): Promise<string | null> {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: AUDIENCE });
    const email = typeof payload.sub === 'string' ? payload.sub : null;
    // A session outlives a change of operator otherwise: rotate the address in
    // the environment and every cookie already issued keeps working.
    if (!email || email !== getConfig().CONSOLE_EMAIL) return null;
    return email;
  } catch {
    return null;
  }
}

const SendSchema = z.object({
  title: z.string().trim().min(1, 'Give the notification a title.').max(100),
  body: z.string().trim().min(1, 'Write the message.').max(500),
  image: z.string().optional(),
  validateOnly: z.boolean().optional(),
});

/**
 * What the sponsor form posts. Everything [SponsorInput] takes, plus the two
 * fields that are about the *image* rather than the card: a freshly picked file
 * as a data URL, and the address of the one already saved.
 */
/**
 * A hand-granted entitlement.
 *
 * `days` absent means it never expires, which is what a grant to yourself or
 * to a friend almost always is. A number is there for the case that actually
 * needs a clock — a trial, or a month given as an apology.
 */
const GrantInput = z.object({
  planId: z.string().uuid(),
  days: z.number().int().min(1).max(3650).optional(),
  note: z.string().trim().max(200).default(''),
});

const SponsorSchema = z.object({
  enabled: z.boolean(),
  label: z.string().max(60).optional(),
  brand: z.string().max(120).optional(),
  byLine: z.string().max(160).optional(),
  pitch: z.string().max(600).optional(),
  cta: z.string().max(60).optional(),
  linkUrl: z.string().max(600).optional(),
  accent: z.string().max(16).optional(),
  /** A new upload. Absent means "keep [imageUrl]". */
  image: z.string().optional(),
  /** The saved image, echoed back. Empty clears it. */
  imageUrl: z.string().max(600).optional(),
});

export function registerConsoleRoutes(app: FastifyInstance): void {
  const html = (reply: FastifyReply, body: string) =>
    reply
      .code(200)
      .header('content-type', 'text/html; charset=utf-8')
      // Without this the browser is free to cache a 200 HTML response on its
      // own guess at a lifetime — and it does. Signing in then landed back on
      // a *cached copy of the login page*: the cookie was set, the redirect
      // ran, and the request never reached the server. The same URL renders
      // two different pages depending on a cookie, so it can never be stored.
      .header('cache-control', 'no-store, must-revalidate')
      // The page carries its own script and loads nothing else; say so, so a
      // stray injection has nowhere to fetch from.
      .header(
        'content-security-policy',
        "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      )
      .header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff')
      .send(body);

  app.get('/console', async (req, reply) => {
    if (!enabled()) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Route not found', requestId: req.id },
      });
    }
    const cfg = getConfig();
    const operator = await currentOperator(req);
    if (!operator) return html(reply, loginPage());
    return html(
      reply,
      consolePage({
        email: operator,
        topic: cfg.FCM_TOPIC,
        images: Boolean(cfg.CONSOLE_MEDIA_DIR && cfg.PUBLIC_BASE_URL),
        // Read on every page load rather than cached: the form is the current
        // state of the slot, and a stale one invites an operator to overwrite a
        // change somebody else made an hour ago.
        sponsor: await readSponsor(),
      }),
    );
  });

  app.post('/console/login', async (req, reply) => {
    if (!enabled()) throw errors.notFound('Route not found');
    const cfg = getConfig();

    // Per-IP, because there is exactly one account here — limiting by email
    // would let an attacker keep trying by varying a field nobody checks.
    enforceLimit(`console:login:${req.ip}`, 8, 15 * 60_000);

    const parsed = z
      .object({ email: z.string().min(1), password: z.string().min(1) })
      .safeParse(req.body);
    if (!parsed.success) throw errors.validation('Enter an email and a password.');

    const email = parsed.data.email.trim().toLowerCase();
    const expected = cfg.CONSOLE_EMAIL.trim().toLowerCase();
    // Verify against a throwaway hash on a wrong address so a bad email and a
    // bad password take the same time — the same argon2 timing dodge the app's
    // own login uses.
    const hash = email === expected ? cfg.CONSOLE_PASSWORD_HASH : await DUMMY_HASH_PROMISE();
    const ok = (await verifyPassword(hash, parsed.data.password)) && email === expected;
    if (!ok) {
      req.log.warn({ ip: req.ip }, 'console sign-in refused');
      throw errors.unauthenticated('That email and password do not match.');
    }

    const ttl = cfg.CONSOLE_SESSION_TTL_SECONDS;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(expected)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`)
      .sign(secret());
    setCookie(reply, token, ttl);
    return { ok: true };
  });

  app.post('/console/logout', async (_req, reply) => {
    setCookie(reply, '', 0);
    return { ok: true };
  });

  app.post(
    '/console/send',
    {
      // A 4 MB image is ~5.5 MB once base64 has had its way with it; the
      // global limit is 1 MB.
      bodyLimit: 8 * 1024 * 1024,
    },
    async (req, reply) => {
      if (!enabled()) throw errors.notFound('Route not found');
      const operator = await currentOperator(req);
      if (!operator) {
        return reply
          .code(401)
          .send({ error: { code: 'UNAUTHENTICATED', message: 'Sign in again.', requestId: req.id } });
      }

      const parsed = SendSchema.safeParse(req.body);
      if (!parsed.success) {
        throw errors.validation(parsed.error.issues[0]?.message ?? 'Check the form.');
      }
      const { title, body, image, validateOnly } = parsed.data;

      // Real sends only. A test costs nothing and should not eat the budget
      // that stops a stuck finger from broadcasting six times.
      if (!validateOnly) enforceLimit(`console:send:${operator}`, 12, 3600_000);

      const stored = image ? storeDataUrl(image) : null;
      const name = await sendToTopic({
        title,
        body,
        imageUrl: stored?.url,
        validateOnly: validateOnly === true,
      });

      req.log.info(
        { operator, validateOnly: validateOnly === true, hasImage: Boolean(stored), name },
        'console notification',
      );
      return { ok: true, id: name, imageUrl: stored?.url };
    },
  );

  app.post(
    '/console/sponsor',
    {
      // Same headroom as a notification image: base64 inflates a 4 MB file to
      // about 5.5, and the global limit is 1 MB.
      bodyLimit: 8 * 1024 * 1024,
    },
    async (req, reply) => {
      if (!enabled()) throw errors.notFound('Route not found');
      const operator = await currentOperator(req);
      if (!operator) {
        return reply
          .code(401)
          .send({ error: { code: 'UNAUTHENTICATED', message: 'Sign in again.', requestId: req.id } });
      }

      const outer = SponsorSchema.safeParse(req.body);
      if (!outer.success) {
        throw errors.validation(outer.error.issues[0]?.message ?? 'Check the form.');
      }
      const b = outer.data;

      // A new file replaces whatever was there; no file keeps the saved one.
      // Pinned, because unlike a notification attachment this URL sits in a row
      // the app reads for months and the 30-day sweep would break the card.
      const stored = b.image ? storeDataUrl(b.image, { pinned: true }) : null;

      const parsed = SponsorInput.safeParse({
        enabled: b.enabled,
        label: b.label ?? 'Sponsored',
        brand: b.brand ?? '',
        byLine: b.byLine ?? '',
        pitch: b.pitch ?? '',
        cta: b.cta ?? '',
        linkUrl: b.linkUrl ?? '',
        accent: b.accent ?? '',
        imageUrl: stored ? stored.url : (b.imageUrl ?? ''),
      });
      if (!parsed.success) {
        throw errors.validation(parsed.error.issues[0]?.message ?? 'Check the form.');
      }

      await writeSponsor(parsed.data);
      req.log.info(
        {
          operator,
          enabled: parsed.data.enabled,
          brand: parsed.data.brand,
          newImage: Boolean(stored),
        },
        'console sponsor saved',
      );
      return { ok: true, imageUrl: parsed.data.imageUrl };
    },
  );

  app.get<{ Querystring: { q?: string; offset?: string } }>('/console/users', async (req, reply) => {
    if (!enabled()) throw errors.notFound('Route not found');
    const operator = await currentOperator(req);
    if (!operator) {
      return reply
        .code(401)
        .send({ error: { code: 'UNAUTHENTICATED', message: 'Sign in again.', requestId: req.id } });
    }
    // A search box that fires on every keystroke is still a handful of
    // covering-index lookups, not a load test — generous on purpose.
    enforceLimit(`console:users:${operator}`, 240, 3600_000);

    const limit = 25;
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const { rows, total } = await listUsers({ search: req.query.q, limit, offset });
    return { ok: true, rows, total, limit, offset };
  });

  app.get<{ Params: { id: string } }>('/console/users/:id', async (req, reply) => {
    if (!enabled()) throw errors.notFound('Route not found');
    const operator = await currentOperator(req);
    if (!operator) {
      return reply
        .code(401)
        .send({ error: { code: 'UNAUTHENTICATED', message: 'Sign in again.', requestId: req.id } });
    }
    enforceLimit(`console:users:${operator}`, 240, 3600_000);

    const user = await getUserDetail(req.params.id);
    if (!user) throw errors.notFound('No such user');
    return { ok: true, user };
  });

  app.get('/console/subscribers', async (req, reply) => {
    if (!enabled()) throw errors.notFound('Route not found');
    const operator = await currentOperator(req);
    if (!operator) {
      return reply
        .code(401)
        .send({ error: { code: 'UNAUTHENTICATED', message: 'Sign in again.', requestId: req.id } });
    }
    return { ok: true, ...(await listSubscriptions()) };
  });

  app.get('/console/analytics', async (req, reply) => {
    if (!enabled()) throw errors.notFound('Route not found');
    const operator = await currentOperator(req);
    if (!operator) {
      return reply
        .code(401)
        .send({ error: { code: 'UNAUTHENTICATED', message: 'Sign in again.', requestId: req.id } });
    }
    enforceLimit(`console:analytics:${operator}`, 120, 3600_000);

    return { ok: true, ...(await analytics()) };
  });

  // ── Plans ────────────────────────────────────────────────────────────────
  //
  // The console owns the *product*: how many plans there are and what each one
  // unlocks. It does not own money — see `plans/repo.ts` on why there is no
  // price field here. The operator creates the product in Play Console, pastes
  // its id in as the sku, and the app asks Play what it costs.

  app.get('/console/plans', async (req, reply) => {
    if (!enabled()) throw errors.notFound('Route not found');
    if (!(await currentOperator(req))) {
      return reply.code(401).send({
        error: { code: 'UNAUTHENTICATED', message: 'Sign in again.', requestId: req.id },
      });
    }
    // Hidden plans included: this is the editor, not the offer.
    return { plans: await listPlans(true) };
  });

  app.post('/console/plans', async (req, reply) => {
    if (!enabled()) throw errors.notFound('Route not found');
    const operator = await currentOperator(req);
    if (!operator) {
      return reply.code(401).send({
        error: { code: 'UNAUTHENTICATED', message: 'Sign in again.', requestId: req.id },
      });
    }
    const parsed = PlanInput.safeParse(req.body);
    if (!parsed.success) {
      throw errors.validation(parsed.error.issues[0]?.message ?? 'Check the form.');
    }
    const plan = await createPlan(parsed.data);
    req.log.info({ operator, planId: plan.id, name: plan.name }, 'console plan created');
    return { plan };
  });

  app.patch<{ Params: { id: string } }>('/console/plans/:id', async (req, reply) => {
    if (!enabled()) throw errors.notFound('Route not found');
    const operator = await currentOperator(req);
    if (!operator) {
      return reply.code(401).send({
        error: { code: 'UNAUTHENTICATED', message: 'Sign in again.', requestId: req.id },
      });
    }
    const parsed = PlanInput.safeParse(req.body);
    if (!parsed.success) {
      throw errors.validation(parsed.error.issues[0]?.message ?? 'Check the form.');
    }
    const plan = await updatePlan(req.params.id, parsed.data);
    if (!plan) throw errors.notFound('Plan not found');
    // Editing a plan's features changes what its holders may do, and there is
    // no cheap way to find them — so every cached entitlement goes. The cache
    // refills in a minute and plans are edited about as often as prices change.
    invalidateAllEntitlements();
    req.log.info({ operator, planId: plan.id, name: plan.name }, 'console plan updated');
    return { plan };
  });

  app.delete<{ Params: { id: string } }>('/console/plans/:id', async (req, reply) => {
    if (!enabled()) throw errors.notFound('Route not found');
    const operator = await currentOperator(req);
    if (!operator) {
      return reply.code(401).send({
        error: { code: 'UNAUTHENTICATED', message: 'Sign in again.', requestId: req.id },
      });
    }
    const result = await deletePlan(req.params.id);
    if (!result.deleted) {
      // Refused rather than cascaded: deleting a held plan would silently drop
      // its holders to the free tier.
      throw errors.validation(
        `${result.holders} ${result.holders === 1 ? 'person is' : 'people are'} on this plan. ` +
          'Switch it off instead — it stops being offered and keeps working for them.',
      );
    }
    req.log.info({ operator, planId: req.params.id }, 'console plan deleted');
    return { ok: true };
  });

  // ── Granting by hand ─────────────────────────────────────────────────────
  //
  // The way the operator gives themselves and other people access without
  // paying, and the only way any of this can be tested before Play Billing is
  // wired. No Play limits apply: it is free access, given away, not sold.

  app.post<{ Params: { id: string } }>('/console/users/:id/entitlement', async (req, reply) => {
    if (!enabled()) throw errors.notFound('Route not found');
    const operator = await currentOperator(req);
    if (!operator) {
      return reply.code(401).send({
        error: { code: 'UNAUTHENTICATED', message: 'Sign in again.', requestId: req.id },
      });
    }
    const parsed = GrantInput.safeParse(req.body);
    if (!parsed.success) {
      throw errors.validation(parsed.error.issues[0]?.message ?? 'Check the form.');
    }
    const { planId, days, note } = parsed.data;
    const plan = await getPlan(planId);
    if (!plan) throw errors.notFound('Plan not found');

    await upsertEntitlement({
      userId: req.params.id,
      planId,
      source: 'grant',
      status: 'active',
      // No days means no expiry at all — the shape most grants take.
      expiresAtSql: days ? addDaysSql(new Date(), days) : null,
      note,
    });
    invalidateEntitlement(req.params.id);
    req.log.info(
      { operator, userId: req.params.id, planId, days: days ?? null },
      'console entitlement granted',
    );
    return { ok: true, entitlement: await readEntitlement(req.params.id) };
  });

  app.delete<{ Params: { id: string } }>('/console/users/:id/entitlement', async (req, reply) => {
    if (!enabled()) throw errors.notFound('Route not found');
    const operator = await currentOperator(req);
    if (!operator) {
      return reply.code(401).send({
        error: { code: 'UNAUTHENTICATED', message: 'Sign in again.', requestId: req.id },
      });
    }
    // Revoke keeps the row, because the row is also where grandfathering
    // lives — see `revokeEntitlement`.
    await revokeEntitlement(req.params.id);
    invalidateEntitlement(req.params.id);
    req.log.info({ operator, userId: req.params.id }, 'console entitlement revoked');
    return { ok: true };
  });

  app.get<{ Params: { name: string } }>('/media/:name', async (req, reply) => {
    const { body, contentType } = readStored(req.params.name);
    return reply
      .code(200)
      .header('content-type', contentType)
      // Anything uploaded is served from the same origin as the API, so pin the
      // type and forbid a browser from second-guessing it into something
      // executable.
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', 'inline')
      .header('content-security-policy', "default-src 'none'; sandbox")
      // Google caches what it fetches, and these names are random and never
      // reused, so this is safe to keep for a long while.
      .header('cache-control', 'public, max-age=604800, immutable')
      .send(body);
  });
}
