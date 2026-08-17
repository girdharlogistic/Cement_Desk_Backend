import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../lib/validate';
import { authenticateVerified, firmAccess, requireRole } from '../../plugins/guards';
import { withIdempotency } from '../freight/service';
import * as svc from './service';

const createSchema = z.object({
  name: z.string().min(1).max(160),
  fyStartMonth: z.number().int().min(1).max(12).default(4),
});
const patchSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  fyStartMonth: z.number().int().min(1).max(12).optional(),
});
const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member', 'viewer']).default('member'),
});
const acceptSchema = z.object({ token: z.string().min(16) });
const roleSchema = z.object({ role: z.enum(['owner', 'admin', 'member', 'viewer']) });

export function registerFirmRoutes(app: FastifyInstance): void {
  app.get('/firms', { preHandler: [authenticateVerified] }, async (req) => svc.listFirms(req.userId));

  app.post('/firms', { preHandler: [authenticateVerified] }, async (req, reply) => {
    const body = parse(createSchema, req.body);
    const key = req.headers['idempotency-key'] as string | undefined;
    const out = await withIdempotency(req.userId, 'POST /firms', key, async () => {
      const firm = await svc.createFirm(req.userId, body.name, body.fyStartMonth);
      return { status: 201, body: { firm } };
    });
    reply.code(out.status);
    return out.body;
  });

  app.patch(
    '/firms/:firmId',
    { preHandler: [authenticateVerified, firmAccess, requireRole('admin')] },
    async (req) => {
      const body = parse(patchSchema, req.body);
      return { firm: await svc.patchFirm(req.firmId, body) };
    },
  );

  app.delete(
    '/firms/:firmId',
    { preHandler: [authenticateVerified, firmAccess, requireRole('owner')] },
    async (req, reply) => {
      await svc.deleteFirm(req.userId, req.firmId);
      reply.code(204);
    },
  );

  app.get('/firms/:firmId/members', { preHandler: [authenticateVerified, firmAccess] }, async (req) =>
    svc.listMembers(req.firmId),
  );

  app.post(
    '/firms/:firmId/members/invite',
    { preHandler: [authenticateVerified, firmAccess, requireRole('admin')] },
    async (req, reply) => {
      const body = parse(inviteSchema, req.body);
      const key = req.headers['idempotency-key'] as string | undefined;
      const out = await withIdempotency(req.userId, `POST invite ${req.firmId} ${body.email.toLowerCase()}`, key, async () => {
        const inv = await svc.inviteMember(req.firmId, body.email, body.role, req.userId);
        return { status: 201, body: inv };
      });
      reply.code(out.status);
      return out.body;
    },
  );

  app.post(
    '/firms/:firmId/members/accept',
    { preHandler: [authenticateVerified] },
    async (req, reply) => {
      const body = parse(acceptSchema, req.body);
      const firm = await svc.acceptInvite(req.userId, body.token);
      reply.code(201);
      return { firm };
    },
  );

  app.patch(
    '/firms/:firmId/members/:userId',
    { preHandler: [authenticateVerified, firmAccess, requireRole('admin')] },
    async (req, reply) => {
      const body = parse(roleSchema, req.body);
      await svc.patchMemberRole(req.firmRole, req.firmId, (req.params as any).userId, body.role);
      reply.code(204);
    },
  );

  app.delete(
    '/firms/:firmId/members/:userId',
    { preHandler: [authenticateVerified, firmAccess, requireRole('admin')] },
    async (req, reply) => {
      await svc.removeMember(req.firmRole, req.userId, req.firmId, (req.params as any).userId);
      reply.code(204);
    },
  );
}
