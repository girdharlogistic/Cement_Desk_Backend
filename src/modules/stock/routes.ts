import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../lib/validate';
import { authenticate, firmAccess, requireRole } from '../../plugins/guards';
import { businessDateOr400, withIdempotency } from '../freight/service';
import * as svc from './service';

const qtyMap = z.record(z.string().uuid(), z.number());
const baselineSchema = z.object({
  date: z.string().min(10).max(30),
  physical: qtyMap.default({}),
  sap: qtyMap.default({}),
  party: z.record(z.string().uuid(), qtyMap).default({}),
});
const createDaySchema = z.object({ date: z.string().min(10).max(30) });
const cellSchema = z.object({
  partyId: z.string().uuid(),
  gradeId: z.string().uuid(),
  billing: z.number().min(0),
  dispatch: z.number().min(0),
});
const receiptSchema = z.object({
  id: z.string().uuid().optional(),
  gradeId: z.string().uuid(),
  qty: z.number().min(0),
  sapQty: z.number().min(0).default(0),
  ref: z.string().max(120).default(''),
});

export function registerStockRoutes(app: FastifyInstance): void {
  // ---- baseline (§3.7, §5.2) ----
  app.get('/firms/:firmId/baseline', { preHandler: [authenticate, firmAccess] }, async (req) =>
    svc.getBaseline(req.firmId),
  );

  app.put('/firms/:firmId/baseline', { preHandler: [authenticate, firmAccess] }, async (req) => {
    const body = parse(baselineSchema, req.body);
    body.date = businessDateOr400(body.date, 'date');
    return svc.putBaseline(req.firmId, req.userId, body as svc.BaselineInput);
  });

  // ---- stock days ----
  app.get('/firms/:firmId/stock-days', { preHandler: [authenticate, firmAccess] }, async (req) => {
    const qy = req.query as any;
    const days = await svc.listStockDays(
      req.firmId,
      qy.from ? businessDateOr400(qy.from, 'from') : undefined,
      qy.to ? businessDateOr400(qy.to, 'to') : undefined,
    );
    return { days };
  });

  app.post('/firms/:firmId/stock-days', { preHandler: [authenticate, firmAccess, requireRole('member')] }, async (req, reply) => {
    const body = parse(createDaySchema, req.body);
    const date = businessDateOr400(body.date, 'date');
    const key = req.headers['idempotency-key'] as string | undefined;
    const idemKey = key ? `${key}:${date}` : undefined; // a key is per-day to keep same-key replays across days safe
    const out = await withIdempotency(req.userId, `POST stock-days ${req.firmId}`, idemKey, async () => {
      const day = await svc.createStockDay(req.firmId, req.userId, date);
      return { status: 201, body: { day } };
    });
    reply.code(out.status);
    return out.body;
  });

  app.get('/firms/:firmId/stock-days/:date', { preHandler: [authenticate, firmAccess] }, async (req) => {
    const date = businessDateOr400((req.params as any).date, 'date');
    return { day: await svc.getStockDay(req.firmId, date) };
  });

  app.put(
    '/firms/:firmId/stock-days/:date/cells',
    { preHandler: [authenticate, firmAccess, requireRole('member')] },
    async (req) => {
      const date = businessDateOr400((req.params as any).date, 'date');
      const body = parse(cellSchema, req.body);
      return { day: await svc.putCell(req.firmId, req.userId, date, body) };
    },
  );

  app.post(
    '/firms/:firmId/stock-days/:date/receipts',
    { preHandler: [authenticate, firmAccess, requireRole('member')] },
    async (req, reply) => {
      const date = businessDateOr400((req.params as any).date, 'date');
      const body = parse(receiptSchema, req.body);
      const day = await svc.addReceipt(req.firmId, req.userId, date, body);
      reply.code(201);
      return { day };
    },
  );

  app.delete(
    '/firms/:firmId/stock-days/:date/receipts/:receiptId',
    { preHandler: [authenticate, firmAccess, requireRole('member')] },
    async (req) => {
      const date = businessDateOr400((req.params as any).date, 'date');
      return { day: await svc.deleteReceipt(req.firmId, req.userId, date, (req.params as any).receiptId) };
    },
  );

  app.delete(
    '/firms/:firmId/stock-days/:date',
    { preHandler: [authenticate, firmAccess, requireRole('member')] },
    async (req, reply) => {
      const date = businessDateOr400((req.params as any).date, 'date');
      await svc.deleteStockDay(req.firmId, req.userId, date);
      reply.code(204);
    },
  );
}
