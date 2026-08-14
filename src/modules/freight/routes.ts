import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../lib/validate';
import { authenticate, firmAccess, requireRole, ifMatchRev } from '../../plugins/guards';
import { errors } from '../../lib/errors';
import { enforceLimit } from '../../lib/limiter';
import * as svc from './service';

const gradeBagsSchema = z.record(z.string().uuid(), z.number().min(0));

const entrySchema = z.object({
  id: z.string().uuid().optional(),
  date: z.string().min(10).max(30),
  partyId: z.string().uuid(),
  locationId: z.string().uuid(),
  vehicleNo: z.string().max(32).default(''),
  revenuePerBag: z.number().min(0),
  bags: z.number().min(0),
  totalReimbursed: z.number(),
  basis: z.enum(['km', 'bag']),
  costRate: z.number().min(0),
  costUnits: z.number().min(0).default(0),
  otherExpenses: z.number().min(0).default(0),
  otherNote: z.string().max(500).default(''),
  totalCost: z.number(),
  profit: z.number(),
  gradeBags: gradeBagsSchema.optional(),
});

const entryPatchSchema = entrySchema.partial().omit({ id: true });

function toWrite(b: any): svc.FreightWrite {
  return {
    ...b,
    vehicleNo: (b.vehicleNo ?? '').toUpperCase(), // client uppercases (§3.5) — keep consistent
    date: svc.businessDateOr400(b.date, 'date'),
  };
}

export function registerFreightRoutes(app: FastifyInstance): void {
  const base = '/firms/:firmId/freight-entries';

  app.get(base, { preHandler: [authenticate, firmAccess] }, async (req) => {
    const qy = req.query as any;
    const limit = Math.min(Math.max(Number(qy.limit) || 200, 1), 500);
    let cursor: { date: string; id: string } | undefined;
    if (qy.cursor) {
      try {
        const c = JSON.parse(Buffer.from(String(qy.cursor), 'base64url').toString());
        cursor = { date: svc.businessDateOr400(c.d, 'cursor.d'), id: String(c.i) };
      } catch (e) {
        if (e instanceof Error && (e as any).status) throw e;
        throw errors.validation('Bad cursor');
      }
    }
    const { rows, nextCursor } = await svc.listEntries(req.firmId, {
      from: qy.from ? svc.businessDateOr400(qy.from, 'from') : undefined,
      to: qy.to ? svc.businessDateOr400(qy.to, 'to') : undefined,
      partyId: qy.partyId,
      locationId: qy.locationId,
      limit,
      cursor,
    });
    return { entries: rows, nextCursor };
  });

  app.post(base, { preHandler: [authenticate, firmAccess, requireRole('member')] }, async (req, reply) => {
    enforceLimit(`push:dev:${req.userId}`, 600, 60_000);
    const body = parse(entrySchema, req.body);
    const key = req.headers['idempotency-key'] as string | undefined;
    const out = await svc.withIdempotency(req.userId, 'POST freight-entries', key, async () => {
      const entry = await svc.createEntry(req.firmId, req.userId, toWrite(body));
      return { status: 201, body: { entry } };
    });
    reply.code(out.status);
    return out.body;
  });

  app.get(`${base}/summary`, { preHandler: [authenticate, firmAccess] }, async (req) => {
    const qy = req.query as any;
    return svc.summary(
      req.firmId,
      qy.from ? svc.businessDateOr400(qy.from, 'from') : undefined,
      qy.to ? svc.businessDateOr400(qy.to, 'to') : undefined,
      qy.partyId,
    );
  });

  app.get(`${base}/:id`, { preHandler: [authenticate, firmAccess] }, async (req) => {
    const entry = await svc.fetchEntry(req.firmId, (req.params as any).id);
    if (!entry || entry.deletedAt) throw errors.notFound('Entry not found');
    return { entry };
  });

  app.patch(`${base}/:id`, { preHandler: [authenticate, firmAccess, requireRole('member')] }, async (req) => {
    const body = parse(entryPatchSchema, req.body);
    const entry = await svc.patchEntry(req.firmId, req.userId, (req.params as any).id, toWriteLoose(body), ifMatchRev(req));
    return { entry };
  });

  app.delete(`${base}/:id`, { preHandler: [authenticate, firmAccess, requireRole('member')] }, async (req, reply) => {
    await svc.deleteEntry(req.firmId, req.userId, (req.params as any).id);
    reply.code(204);
  });
}

function toWriteLoose(b: any): Partial<svc.FreightWrite> {
  const out = { ...b };
  if (out.date !== undefined) out.date = svc.businessDateOr400(out.date, 'date');
  if (out.vehicleNo !== undefined) out.vehicleNo = String(out.vehicleNo).toUpperCase();
  return out;
}
