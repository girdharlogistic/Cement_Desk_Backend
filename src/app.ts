import Fastify, { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { AppError } from './lib/errors';
import { pingDb } from './db/pool';
import { registerAuthRoutes } from './modules/auth/routes';
import { registerFirmRoutes } from './modules/firms/routes';
import { registerMasterRoutes } from './modules/masters/routes';
import { registerFreightRoutes } from './modules/freight/routes';
import { registerStockRoutes } from './modules/stock/routes';
import { registerLandingRoutes } from './modules/landing/routes';
import { registerSyncRoutes } from './modules/sync/routes';
import { registerBackupRoutes } from './modules/backup/routes';
import { registerConsoleRoutes } from './modules/console/routes';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: {
        // §13.4: never log passwords, tokens, or auth bodies.
        paths: [
          'req.headers.authorization',
          'body.password', 'body.newPassword', 'body.currentPassword',
          'body.refreshToken', 'body.token',
          'res.body.tokens', 'res.body.refreshToken',
        ],
        censor: '[redacted]',
      },
    },
    bodyLimit: 1024 * 1024, // 1 MB default (§14); /import/backup overrides to 25 MB
    genReqId: () => randomUUID(),
    trustProxy: true,
  });

  // ---- global error envelope (§10) ----
  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id;
    if (err instanceof AppError) {
      const body: any = {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
          requestId,
        },
        ...((err as any).server ? { server: (err as any).server } : {}),
      };
      if ((err as any).retryAfter) reply.header('Retry-After', String((err as any).retryAfter));
      void reply.code(err.status).send(body);
      return;
    }
    const anyErr = err as any;
    if (anyErr.statusCode === 400 && anyErr.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      void reply.code(400).send({ error: { code: 'VALIDATION_FAILED', message: 'Unsupported content type', requestId } });
      return;
    }
    if (anyErr.statusCode === 413 || anyErr.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      void reply.code(413).send({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large', requestId } });
      return;
    }
    if (anyErr.statusCode && anyErr.statusCode < 500) {
      // Fastify framework errors: bad JSON, etc.
      const code = anyErr.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || anyErr.message?.includes('JSON') ? 'MALFORMED_JSON' : 'VALIDATION_FAILED';
      void reply.code(anyErr.statusCode).send({ error: { code, message: anyErr.message, requestId } });
      return;
    }
    req.log.error({ err, requestId }, 'unhandled error');
    void reply
      .code(500)
      .send({ error: { code: 'INTERNAL', message: 'Internal server error', requestId } });
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: req.id } });
  });

  app.get('/health', async (req, reply) => {
    const db = await pingDb();
    if (!db) return reply.code(503).send({ ok: false, db: 'down', requestId: req.id });
    return { ok: true, db: 'up' };
  });

  // Outside the /api/v1 prefix on purpose: /console is a web page and /media
  // serves the images Google fetches for a notification, neither of which is
  // part of the app's API surface.
  registerConsoleRoutes(app);

  await app.register(
    async (api) => {
      registerAuthRoutes(api);
      registerFirmRoutes(api);
      registerMasterRoutes(api);
      registerFreightRoutes(api);
      registerStockRoutes(api);
      registerLandingRoutes(api);
      registerSyncRoutes(api);
      registerBackupRoutes(api);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
