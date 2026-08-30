import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../lib/validate';
import { authenticateVerified, firmAccess, requireRole, ifMatchRev } from '../../plugins/guards';
import { errors } from '../../lib/errors';
import { businessDateOr400, withIdempotency } from '../freight/service';
import * as purchases from './purchases';
import * as schemes from './schemes';
import * as claims from './claims';

const paymentSchema = z.object({
  id: z.string().uuid().optional(),
  date: z.string().min(10).max(30),
  amount: z.number().min(0),
});
const purchaseSchema = z.object({
  id: z.string().uuid().optional(),
  date: z.string().min(10).max(30),
  companyId: z.string().uuid(),
  gradeId: z.string().uuid(),
  sourceId: z.string().uuid(),
  qty: z.number().positive(),
  ratePerBag: z.number().min(0),
  invoiceNo: z.string().max(80).default(''),
  payments: z.array(paymentSchema).max(200).optional(),
});
const purchasePatchSchema = purchaseSchema.partial().omit({ id: true, payments: true });

const slabSchema = z.object({ from: z.number(), value: z.number() });
const schemeSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  companyId: z.string().uuid(),
  // Empty = every grade. `gradeId` stays accepted for clients that predate
  // multi-grade schemes; the service normalises the two into one set.
  gradeIds: z.array(z.string().uuid()).max(200).optional(),
  gradeId: z.string().uuid().nullish(),
  folderId: z.string().uuid().nullish(),
  perGrade: z.boolean().default(false),
  sourceId: z.string().uuid().nullish(),
  kind: z.enum(['fixed', 'variable', 'mix', 'cash']),
  period: z.enum(['monthly', 'quarterly', 'annual']).nullish(),
  windowFrom: z.string().min(10).max(30).nullish(),
  windowTo: z.string().min(10).max(30).nullish(),
  qtyUnit: z.enum(['bag', 'mt']).default('bag'),
  valueType: z.enum(['perBag', 'perMt', 'percent']).default('perBag'),
  premiumGradeIds: z.array(z.string().uuid()).default([]),
  minPremiumQty: z.number().min(0).default(0),
  minPremiumUnit: z.enum(['bag', 'mt']).default('mt'), // §11.2 trap: default is mt (index 1)
  slabs: z.array(slabSchema).max(200).default([]),
  active: z.boolean().default(true),
});
const schemePatchSchema = schemeSchema.partial().omit({ id: true });
const activateSchema = z.object({ active: z.boolean() });

const claimSchema = z.object({
  id: z.string().uuid().optional(),
  schemeId: z.string().uuid(),
  companyId: z.string().uuid(),
  schemeName: z.string().max(200).default(''),
  periodFrom: z.string().min(10).max(30),
  periodTo: z.string().min(10).max(30),
  label: z.string().max(60).default(''),
  bags: z.number().min(0),
  accrued: z.number().min(0),
});
// Only status/sentOn/schemeName are mutable (§5.4); frozen fields are still
// allowed through so the service can 409 when they *differ*.
const claimPatchSchema = claimSchema
  .partial()
  .omit({ id: true })
  .extend({ status: z.enum(['claimable', 'claimed', 'received']).optional(), sentOn: z.string().min(10).max(30).nullable().optional() });
const creditNoteSchema = z.object({
  id: z.string().uuid().optional(),
  date: z.string().min(10).max(30),
  number: z.string().max(80).default(''),
  amount: z.number().min(0),
});

function normDates<T extends { date?: string | null }>(b: T): T {
  if (b.date != null) b.date = businessDateOr400(b.date, 'date');
  return b;
}

function normSchemeDates<T extends { windowFrom?: string | null; windowTo?: string | null }>(b: T): T {
  if (b.windowFrom != null) b.windowFrom = businessDateOr400(b.windowFrom, 'windowFrom');
  if (b.windowTo != null) b.windowTo = businessDateOr400(b.windowTo, 'windowTo');
  return b;
}

export function registerLandingRoutes(app: FastifyInstance): void {
  // ---- purchases ----
  app.get('/firms/:firmId/purchases', { preHandler: [authenticateVerified, firmAccess] }, async (req) => {
    const qy = req.query as any;
    const limit = Math.min(Math.max(Number(qy.limit) || 200, 1), 500);
    let cursor: { date: string; id: string } | undefined;
    if (qy.cursor) {
      try {
        const c = JSON.parse(Buffer.from(String(qy.cursor), 'base64url').toString());
        cursor = { date: businessDateOr400(c.d, 'cursor.d'), id: String(c.i) };
      } catch {
        throw errors.validation('Bad cursor');
      }
    }
    const { rows, nextCursor } = await purchases.listPurchases(req.firmId, {
      from: qy.from ? businessDateOr400(qy.from, 'from') : undefined,
      to: qy.to ? businessDateOr400(qy.to, 'to') : undefined,
      companyId: qy.companyId,
      gradeId: qy.gradeId,
      limit,
      cursor,
    });
    return { purchases: rows, nextCursor };
  });

  app.post('/firms/:firmId/purchases', { preHandler: [authenticateVerified, firmAccess, requireRole('member')] }, async (req, reply) => {
    const body = parse(purchaseSchema, req.body);
    const key = req.headers['idempotency-key'] as string | undefined;
    const out = await withIdempotency(req.userId, 'POST purchases', key, async () => {
      body.date = businessDateOr400(body.date, 'date');
      body.payments?.forEach((p) => (p.date = businessDateOr400(p.date, 'payments.date')));
      const purchase = await purchases.createPurchase(req.firmId, req.userId, body as purchases.PurchaseWrite);
      return { status: 201, body: { purchase } };
    });
    reply.code(out.status);
    return out.body;
  });

  app.patch('/firms/:firmId/purchases/:id', { preHandler: [authenticateVerified, firmAccess, requireRole('member')] }, async (req) => {
    const body = normDates(parse(purchasePatchSchema, req.body));
    const purchase = await purchases.patchPurchase(req.firmId, req.userId, (req.params as any).id, body, ifMatchRev(req));
    return { purchase };
  });

  app.delete('/firms/:firmId/purchases/:id', { preHandler: [authenticateVerified, firmAccess, requireRole('member')] }, async (req, reply) => {
    await purchases.deletePurchase(req.firmId, req.userId, (req.params as any).id);
    reply.code(204);
  });

  app.post('/firms/:firmId/purchases/:id/payments', { preHandler: [authenticateVerified, firmAccess, requireRole('member')] }, async (req, reply) => {
    const body = normDates(parse(paymentSchema, req.body));
    const purchase = await purchases.addPayment(req.firmId, req.userId, (req.params as any).id, body);
    reply.code(201);
    return { purchase };
  });

  app.delete(
    '/firms/:firmId/purchases/:id/payments/:paymentId',
    { preHandler: [authenticateVerified, firmAccess, requireRole('member')] },
    async (req) => {
      const purchase = await purchases.deletePayment(req.firmId, req.userId, (req.params as any).id, (req.params as any).paymentId);
      return { purchase };
    },
  );

  // ---- schemes ----
  app.get('/firms/:firmId/schemes', { preHandler: [authenticateVerified, firmAccess] }, async (req) => {
    const qy = req.query as any;
    const active = qy.active === 'true' ? true : qy.active === 'false' ? false : undefined;
    return { schemes: await schemes.listSchemes(req.firmId, qy.companyId, active) };
  });

  app.post('/firms/:firmId/schemes', { preHandler: [authenticateVerified, firmAccess, requireRole('member')] }, async (req, reply) => {
    const body = normSchemeDates(parse(schemeSchema, req.body));
    const scheme = await schemes.createScheme(req.firmId, req.userId, body as schemes.SchemeWrite);
    reply.code(201);
    return { scheme };
  });

  app.patch('/firms/:firmId/schemes/:id', { preHandler: [authenticateVerified, firmAccess, requireRole('member')] }, async (req) => {
    const body = normSchemeDates(parse(schemePatchSchema, req.body));
    const scheme = await schemes.patchScheme(req.firmId, req.userId, (req.params as any).id, body, ifMatchRev(req));
    return { scheme };
  });

  app.post('/firms/:firmId/schemes/:id/activate', { preHandler: [authenticateVerified, firmAccess, requireRole('member')] }, async (req) => {
    const body = parse(activateSchema, req.body);
    return { scheme: await schemes.setActive(req.firmId, req.userId, (req.params as any).id, body.active) };
  });

  app.delete('/firms/:firmId/schemes/:id', { preHandler: [authenticateVerified, firmAccess, requireRole('member')] }, async (req, reply) => {
    await schemes.deleteScheme(req.firmId, req.userId, (req.params as any).id);
    reply.code(204);
  });

  // ---- claims ----
  app.get('/firms/:firmId/claims', { preHandler: [authenticateVerified, firmAccess] }, async (req) => {
    const qy = req.query as any;
    return { claims: await claims.listClaims(req.firmId, qy.status, qy.companyId) };
  });

  app.post('/firms/:firmId/claims', { preHandler: [authenticateVerified, firmAccess, requireRole('member')] }, async (req, reply) => {
    const body = parse(claimSchema, req.body);
    body.periodFrom = businessDateOr400(body.periodFrom, 'periodFrom');
    body.periodTo = businessDateOr400(body.periodTo, 'periodTo');
    const key = req.headers['idempotency-key'] as string | undefined;
    const out = await withIdempotency(req.userId, `POST claims ${req.firmId}`, key, async () => {
      const claim = await claims.createClaim(req.firmId, req.userId, body as claims.ClaimWrite);
      return { status: 201, body: { claim } };
    });
    reply.code(out.status);
    return out.body;
  });

  app.patch('/firms/:firmId/claims/:id', { preHandler: [authenticateVerified, firmAccess, requireRole('member')] }, async (req) => {
    const raw: any = parse(claimPatchSchema, req.body);
    if (raw.periodFrom != null) raw.periodFrom = businessDateOr400(raw.periodFrom, 'periodFrom');
    if (raw.periodTo != null) raw.periodTo = businessDateOr400(raw.periodTo, 'periodTo');
    if (raw.sentOn != null) raw.sentOn = businessDateOr400(raw.sentOn, 'sentOn');
    const claim = await claims.patchClaim(req.firmId, req.userId, (req.params as any).id, raw, ifMatchRev(req));
    return { claim };
  });

  app.delete('/firms/:firmId/claims/:id', { preHandler: [authenticateVerified, firmAccess, requireRole('member')] }, async (req, reply) => {
    await claims.deleteClaim(req.firmId, req.userId, (req.params as any).id);
    reply.code(204);
  });

  app.post('/firms/:firmId/claims/:id/credit-notes', { preHandler: [authenticateVerified, firmAccess, requireRole('member')] }, async (req, reply) => {
    const body = normDates(parse(creditNoteSchema, req.body));
    const claim = await claims.addCreditNote(req.firmId, req.userId, (req.params as any).id, body);
    reply.code(201);
    return { claim };
  });

  app.delete(
    '/firms/:firmId/claims/:id/credit-notes/:cnId',
    { preHandler: [authenticateVerified, firmAccess, requireRole('member')] },
    async (req) => {
      const claim = await claims.deleteCreditNote(req.firmId, req.userId, (req.params as any).id, (req.params as any).cnId);
      return { claim };
    },
  );
}
