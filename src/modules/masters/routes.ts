import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../lib/validate';
import { authenticateVerified, firmAccess, requireRole, ifMatchRev, syncMeta } from '../../plugins/guards';
import { tx } from '../../db/pool';
import { errors, isDuplicateKey } from '../../lib/errors';
import { num } from '../../lib/num';
import { isUuid, newId } from '../../lib/ids';
import { withIdempotency } from '../freight/service';
import * as svc from './service';
import { MasterTable } from './service';

interface MasterDef {
  apiName: string; // URL segment & wire name
  table: MasterTable;
  createSchema: z.ZodObject<any>;
  patchSchema: z.ZodObject<any>;
  /** request body → DB columns */
  toCols(body: any): Record<string, unknown>;
  /** DB row → wire JSON */
  mapRow(row: any): any;
  orderBy: string;
}

const code = z.string().max(40).nullish();
const phone = z.string().max(20).nullish();
const orderField = z.number().int().min(0).max(1_000_000).optional();
const idField = z.string().uuid().optional();
const name160 = z.string().min(1).max(160);

export const MASTER_DEFS: MasterDef[] = [
  {
    apiName: 'parties',
    table: 'parties',
    createSchema: z.object({ id: idField, code, name: name160, phone, order: orderField }),
    patchSchema: z.object({ code, name: name160.optional(), phone, order: orderField }),
    toCols: (b) => ({
      ...(b.code !== undefined ? { code: b.code ?? null } : {}),
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.phone !== undefined ? { phone: b.phone ?? null } : {}),
      ...(b.order !== undefined ? { sort_order: b.order } : {}),
    }),
    mapRow: (r) => ({
      id: r.id,
      firmId: r.firm_id,
      code: r.code ?? null,
      name: r.name,
      phone: r.phone ?? null,
      order: Number(r.sort_order),
      ...syncMeta(r),
    }),
    // §3.2: order ASC, numeric code (non-numeric sorts last at rank 1<<20), name CI.
    orderBy: `ORDER BY sort_order ASC,
      CASE WHEN code IS NULL OR code NOT REGEXP '^[0-9]+$' THEN 1048576 ELSE CAST(code AS DECIMAL(20,0)) END ASC,
      LOWER(name) ASC`,
  },
  {
    apiName: 'locations',
    table: 'locations',
    createSchema: z.object({ id: idField, name: name160 }),
    patchSchema: z.object({ name: name160.optional() }),
    toCols: (b) => ({ ...(b.name !== undefined ? { name: b.name } : {}) }),
    mapRow: (r) => ({ id: r.id, firmId: r.firm_id, name: r.name, ...syncMeta(r) }),
    orderBy: 'ORDER BY LOWER(name) ASC',
  },
  {
    apiName: 'grades',
    table: 'grades',
    createSchema: z.object({
      id: idField,
      name: z.string().min(1).max(80),
      order: orderField,
      bagWeightKg: z.number().positive().max(99999).optional(),
    }),
    patchSchema: z.object({
      name: z.string().min(1).max(80).optional(),
      order: orderField,
      bagWeightKg: z.number().positive().max(99999).optional(),
    }),
    toCols: (b) => ({
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.order !== undefined ? { sort_order: b.order } : {}),
      ...(b.bagWeightKg !== undefined ? { bag_weight_kg: b.bagWeightKg } : {}),
    }),
    mapRow: (r) => ({
      id: r.id,
      firmId: r.firmId ?? r.firm_id,
      name: r.name,
      order: Number(r.sort_order),
      bagWeightKg: num(r.bag_weight_kg),
      ...syncMeta(r),
    }),
    orderBy: 'ORDER BY sort_order ASC, LOWER(name) ASC',
  },
  {
    apiName: 'companies',
    table: 'companies',
    createSchema: z.object({ id: idField, name: name160, order: orderField }),
    patchSchema: z.object({ name: name160.optional(), order: orderField }),
    toCols: (b) => ({
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.order !== undefined ? { sort_order: b.order } : {}),
    }),
    mapRow: (r) => ({
      id: r.id,
      firmId: r.firm_id,
      name: r.name,
      order: Number(r.sort_order),
      ...syncMeta(r),
    }),
    orderBy: 'ORDER BY sort_order ASC, LOWER(name) ASC',
  },
  {
    apiName: 'sources',
    table: 'sources',
    createSchema: z.object({
      id: idField,
      name: name160,
      type: z.enum(['plant', 'depot']).optional(),
      order: orderField,
    }),
    patchSchema: z.object({ name: name160.optional(), type: z.enum(['plant', 'depot']).optional(), order: orderField }),
    toCols: (b) => ({
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.type !== undefined ? { type: b.type } : {}),
      ...(b.order !== undefined ? { sort_order: b.order } : {}),
    }),
    mapRow: (r) => ({
      id: r.id,
      firmId: r.firm_id,
      name: r.name,
      type: r.type,
      order: Number(r.sort_order),
      ...syncMeta(r),
    }),
    orderBy: 'ORDER BY sort_order ASC, LOWER(name) ASC',
  },
];

export function mapMasterRow(table: MasterTable | 'party_routes', row: any): any {
  if (table === 'party_routes') return mapRoute(row);
  return MASTER_DEFS.find((d) => d.table === table)!.mapRow(row);
}

export function mapRoute(r: any): any {
  return {
    id: r.id,
    firmId: r.firm_id,
    partyId: r.party_id,
    locationId: r.location_id,
    key: `${r.party_id}::${r.location_id}`, // client natural key (§9.6)
    distanceKm: num(r.distance_km),
    revenuePerBag: num(r.revenue_per_bag),
    ...syncMeta(r),
  };
}

const reorderSchema = z.object({ ids: z.array(z.string().uuid()).max(5000) });

const routeUpsertSchema = z.object({
  partyId: z.string().uuid(),
  locationId: z.string().uuid(),
  distanceKm: z.number().min(0).max(9999999),
  revenuePerBag: z.number().min(0).max(99999999),
});

export function registerMasterRoutes(app: FastifyInstance): void {
  for (const def of MASTER_DEFS) {
    const base = `/firms/:firmId/${def.apiName}`;

    app.get(base, { preHandler: [authenticateVerified, firmAccess] }, async (req) => {
      const includeDeleted = (req.query as any).includeDeleted === 'true';
      const rows = await svc.listRows(def.table, req.firmId, includeDeleted, def.orderBy);
      return rows.map(def.mapRow);
    });

    app.post(base, { preHandler: [authenticateVerified, firmAccess, requireRole('member')] }, async (req, reply) => {
      const body = parse(def.createSchema, req.body);
      const key = req.headers['idempotency-key'] as string | undefined;
      const out = await withIdempotency(req.userId, `POST ${def.apiName} ${req.firmId}`, key, async () => {
        const { row, created } = await svc.createRow(def.table, req.firmId, body.id, def.toCols(body), req.userId);
        return { status: created ? 201 : 200, body: { [sing(def.apiName)]: def.mapRow(row) } };
      });
      reply.code(out.status);
      return out.body;
    });

    app.patch(`${base}/:id`, { preHandler: [authenticateVerified, firmAccess, requireRole('member')] }, async (req) => {
      const body = parse(def.patchSchema, req.body);
      const row = await svc.updateRow(
        def.table,
        req.firmId,
        (req.params as any).id,
        def.toCols(body),
        req.userId,
        ifMatchRev(req),
      );
      return { [sing(def.apiName)]: def.mapRow(row) };
    });

    app.delete(`${base}/:id`, { preHandler: [authenticateVerified, firmAccess, requireRole('member')] }, async (req, reply) => {
      await tx((c) => svc.deleteWithCascade(c, def.table, req.firmId, (req.params as any).id, req.userId));
      reply.code(204);
    });

    app.post(`${base}/reorder`, { preHandler: [authenticateVerified, firmAccess, requireRole('member')] }, async (req, reply) => {
      const body = parse(reorderSchema, req.body);
      await svc.reorderRows(def.table, req.firmId, body.ids, req.userId);
      reply.code(204);
    });
  }

  // ---- party routes (prefill defaults only, §3.4) — natural-key upsert ----
  app.get('/firms/:firmId/routes', { preHandler: [authenticateVerified, firmAccess] }, async (req) => {
    const includeDeleted = (req.query as any).includeDeleted === 'true';
    const rows = await svc.listRows(
      'party_routes',
      req.firmId,
      includeDeleted,
      'ORDER BY party_id, location_id',
    );
    return rows.map(mapRoute);
  });

  app.put('/firms/:firmId/routes', { preHandler: [authenticateVerified, firmAccess, requireRole('member')] }, async (req) => {
    const body = parse(routeUpsertSchema, req.body);
    const fields = {
      party_id: body.partyId,
      location_id: body.locationId,
      distance_km: body.distanceKm,
      revenue_per_bag: body.revenuePerBag,
    };
    try {
      const { row, created } = await svc.createRow('party_routes', req.firmId, undefined, fields, req.userId);
      return { route: mapRoute(row), created };
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      // Natural-key hit: live or tombstoned — resurrect/update in place (§6.3b).
      const row = await tx(async (c) => {
        await c.query(
          `UPDATE party_routes SET distance_km = ?, revenue_per_bag = ?, deleted_at = NULL,
             rev = rev + 1, updated_by = ? WHERE firm_id = ? AND party_id = ? AND location_id = ?`,
          [body.distanceKm, body.revenuePerBag, req.userId, req.firmId, body.partyId, body.locationId],
        );
        const [rows] = await c.query(
          'SELECT * FROM party_routes WHERE firm_id = ? AND party_id = ? AND location_id = ?',
          [req.firmId, body.partyId, body.locationId],
        );
        return (rows as any[])[0];
      });
      return { route: mapRoute(row), created: false };
    }
  });

  app.delete(
    '/firms/:firmId/routes/:partyId/:locationId',
    { preHandler: [authenticateVerified, firmAccess, requireRole('member')] },
    async (req, reply) => {
      const { partyId, locationId } = req.params as any;
      if (!isUuid(partyId) || !isUuid(locationId)) throw errors.validation('Invalid route key');
      await tx(async (c) => {
        const existing = await c.query(
          'SELECT id FROM party_routes WHERE firm_id = ? AND party_id = ? AND location_id = ? AND deleted_at IS NULL',
          [req.firmId, partyId, locationId],
        );
        const row = (existing[0] as any[])[0];
        if (row) await svc.softDeleteRow(c, 'party_routes', req.firmId, row.id, req.userId);
      });
      reply.code(204);
    },
  );
}

function sing(apiName: string): string {
  return apiName === 'parties'
    ? 'party'
    : apiName === 'companies'
      ? 'company'
      : apiName === 'sources'
        ? 'source'
        : apiName === 'grades'
          ? 'grade'
          : 'location';
}

/** Route list helper for sync pull (shared with §9). */
export async function listRoutesRaw(firmId: string) {
  return svc.listRows('party_routes', firmId, true, 'ORDER BY updated_at ASC');
}

export { newId as _newIdForTests };
