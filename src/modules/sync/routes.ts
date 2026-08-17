import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../lib/validate';
import { authenticateVerified, firmAccess, requireRole } from '../../plugins/guards';
import { enforceLimit } from '../../lib/limiter';
import { qOne } from '../../db/pool';
import { sqlToIso } from '../../lib/dates';
import { withIdempotency } from '../freight/service';
import { pull } from './pull';
import { push, Mutation, PushOutcome } from './push';
import { counts } from './counts';

const pullQuerySchema = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(1000),
  deviceId: z.string().uuid().optional(),
});

const pushSchema = z.object({
  deviceId: z.string().max(64).default(''),
  baseCursor: z.string().max(64).nullish(),
  mutations: z
    .array(
      z.object({
        op: z.enum(['upsert', 'delete']),
        entity: z.string().min(1).max(40),
        id: z.string().min(1).max(120),
        rev: z.number().int().min(0).optional(),
        data: z.any().optional(),
      }),
    )
    .max(500, 'mutations capped at 500 per request — chunk on the client (§9.3)'),
});

export function registerSyncRoutes(app: FastifyInstance): void {
  app.get('/firms/:firmId/sync/pull', { preHandler: [authenticateVerified, firmAccess] }, async (req) => {
    const qy = parse(pullQuerySchema, req.query ?? {});
    return pull(req.firmId, req.userId, qy.cursor, qy.limit, qy.deviceId);
  });

  // Read-only, and read by a device that has nothing yet — a restoring client
  // calls this once per firm to turn its download into a real progress bar.
  app.get('/firms/:firmId/sync/counts', { preHandler: [authenticateVerified, firmAccess] }, async (req) =>
    counts(req.firmId),
  );

  app.post(
    '/firms/:firmId/sync/push',
    { preHandler: [authenticateVerified, firmAccess, requireRole('member')] },
    async (req) => {
      const body = parse(pushSchema, req.body);
      enforceLimit(`syncpush:dev:${body.deviceId || req.userId}`, 60, 60_000);
      const key = req.headers['idempotency-key'] as string | undefined;
      const out = await withIdempotency(req.userId, `POST sync/push ${req.firmId}`, key, async () => {
        const outcomes = await push(req.firmId, req.userId, body.mutations as Mutation[]);
        const serverTime = (await qOne<{ u: string }>('SELECT UTC_TIMESTAMP(3) AS u'))!.u;
        return {
          status: 200,
          body: {
            serverTime: sqlToIso(serverTime),
            applied: outcomes.filter((o) => o.status === 'applied').map(({ entity, id, rev }) => ({ entity, id, rev })),
            conflicts: outcomes
              .filter((o) => o.status === 'conflict')
              .map(({ entity, id, reason, server }) => ({ entity, id, reason, server })),
            rejected: outcomes
              .filter((o) => o.status === 'rejected')
              .map(({ entity, id, code, message }) => ({ entity, id, code, message })),
            serials: (outcomes as PushOutcome[])
              .filter((o) => o.serial !== undefined)
              .map(({ entity, id, serial }) => ({ entity, id, serial })),
          },
        };
      });
      return out.body;
    },
  );
}
