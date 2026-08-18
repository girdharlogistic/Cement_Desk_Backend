import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { getConfig } from '../../config';
import { errors } from '../../lib/errors';
import { enforceLimit } from '../../lib/limiter';
import { verifyPassword, DUMMY_HASH_PROMISE } from '../../lib/passwords';
import { sendToTopic } from './fcm';
import { readStored, storeDataUrl } from './media';
import { consolePage, loginPage } from './page';

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
