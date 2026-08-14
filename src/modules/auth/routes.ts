import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../lib/validate';
import { enforceLimit } from '../../lib/limiter';
import { errors } from '../../lib/errors';
import { authenticate } from '../../plugins/guards';
import * as svc from './service';

const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters');
const phoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, 'Phone must be E.164 (e.g. +919812345678)');

const signupSchema = z.object({
  email: z.string().email().max(255),
  password: passwordSchema,
  displayName: z.string().max(120).default(''),
  firmName: z.string().min(1).max(160).optional(),
  fyStartMonth: z.number().int().min(1).max(12).optional(),
});
const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(128),
  deviceId: z.string().uuid().optional(),
  deviceLabel: z.string().max(120).optional(),
});
const refreshSchema = z.object({ refreshToken: z.string().min(16).max(512) });
const patchMeSchema = z.object({
  displayName: z.string().max(120).optional(),
  phone: z.union([phoneSchema, z.literal('')]).optional(),
});
const changePwSchema = z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema });
const forgotSchema = z.object({ email: z.string().email() });
const resetSchema = z.object({ token: z.string().min(16), newPassword: passwordSchema });
const verifySchema = z.object({ token: z.string().min(16) });

const HOUR = 3600_000;
const MIN15 = 900_000;

export function registerAuthRoutes(app: FastifyInstance): void {
  // ---- public ----
  app.post('/auth/signup', async (req, reply) => {
    enforceLimit(`signup:ip:${req.ip}`, 5, HOUR);
    const body = parse(signupSchema, req.body);
    const { user, tokens, firm } = await svc.signup(
      body.email,
      body.password,
      body.displayName,
      body.firmName,
      body.fyStartMonth,
    );
    reply.code(201);
    return { user, tokens, firm };
  });

  app.post('/auth/login', async (req) => {
    enforceLimit(`login:ip:${req.ip}`, 10, MIN15);
    const body = parse(loginSchema, req.body);
    // Per-email throttle inside service-level limit (§7.4).
    enforceLimit(`login:email:${body.email.toLowerCase()}`, 5, MIN15);
    const { user, tokens } = await svc.login(
      body.email,
      body.password,
      body.deviceId,
      body.deviceLabel,
      String(req.headers['user-agent'] ?? ''),
    );
    return { user, tokens };
  });

  app.post('/auth/refresh', async (req) => {
    enforceLimit(`refresh:ip:${req.ip}`, 60, HOUR);
    const body = parse(refreshSchema, req.body);
    const { tokens, userId } = await svc.refresh(body.refreshToken);
    enforceLimit(`refresh:user:${userId}`, 60, HOUR);
    return { tokens };
  });

  app.post('/auth/logout', async (req, reply) => {
    const body = parse(refreshSchema, req.body);
    await svc.logout(body.refreshToken);
    reply.code(204);
  });

  app.post('/auth/forgot-password', async (req, reply) => {
    enforceLimit(`forgot:ip:${req.ip}`, 10, HOUR);
    const body = parse(forgotSchema, req.body);
    enforceLimit(`forgot:email:${body.email.toLowerCase()}`, 3, HOUR);
    await svc.forgotPassword(body.email);
    reply.code(204);
  });

  app.post('/auth/reset-password', async (req, reply) => {
    const body = parse(resetSchema, req.body);
    await svc.resetPassword(body.token, body.newPassword);
    reply.code(204);
  });

  app.post('/auth/verify-email', async (req, reply) => {
    const body = parse(verifySchema, req.body);
    await svc.verifyEmail(body.token);
    reply.code(204);
  });

  // ---- authenticated ----
  app.post('/auth/logout-all', { preHandler: [authenticate] }, async (req, reply) => {
    await svc.logoutAll(req.userId);
    reply.code(204);
  });

  app.get('/auth/me', { preHandler: [authenticate] }, async (req) => svc.me(req.userId));

  app.patch('/auth/me', { preHandler: [authenticate] }, async (req) => {
    const body = parse(patchMeSchema, req.body);
    return { user: await svc.patchMe(req.userId, body) };
  });

  app.post('/auth/change-password', { preHandler: [authenticate] }, async (req, reply) => {
    const body = parse(changePwSchema, req.body);
    await svc.changePassword(req.userId, req.sessionId, body.currentPassword, body.newPassword);
    reply.code(204);
  });

  app.get('/auth/sessions', { preHandler: [authenticate] }, async (req) =>
    svc.listSessions(req.userId, req.sessionId),
  );

  app.delete('/auth/sessions/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!id) throw errors.validation('Missing session id');
    await svc.revokeSession(req.userId, id);
    reply.code(204);
  });
}
