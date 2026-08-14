import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../lib/validate';
import { errors } from '../../lib/errors';
import { authenticate, firmAccess, requireRole } from '../../plugins/guards';
import { withIdempotency } from '../freight/service';
import { importBackup } from './backupImport';
import { exportBackup } from './backupExport';

const BODY_LIMIT = 25 * 1024 * 1024; // 25 MB for backup payloads (§14)

export function registerBackupRoutes(app: FastifyInstance): void {
  app.post(
    '/firms/:firmId/import/backup',
    { preHandler: [authenticate, firmAccess, requireRole('admin')], bodyLimit: BODY_LIMIT },
    async (req) => {
      const mode = ((req.query as any).mode ?? 'merge') as 'replace' | 'merge';
      if (mode !== 'replace' && mode !== 'merge') throw errors.validation('mode must be replace|merge');
      if (mode === 'replace' && (req.body as any)?.confirmReplace !== true) {
        // Destructive op needs explicit confirmation (§8.7).
        throw errors.validation('mode=replace requires {"confirmReplace": true} in the request body', [
          { field: 'confirmReplace', code: 'REQUIRED', message: 'Set confirmReplace to true to wipe and restore' },
        ]);
      }
      const key = req.headers['idempotency-key'] as string | undefined;
      const out = await withIdempotency(req.userId, `POST import/backup ${req.firmId} ${mode}`, key, async () => {
        const result = await importBackup(req.firmId, req.userId, req.body, mode);
        return { status: 200, body: result };
      });
      return out.body;
    },
  );

  app.get('/firms/:firmId/export/backup', { preHandler: [authenticate, firmAccess] }, async (req, reply) => {
    const payload = await exportBackup(req.firmId);
    if (!payload) throw errors.notFound('Firm not found');
    reply.header('Content-Disposition', `attachment; filename="cement-desk-backup-${req.firmId}.json"`);
    return payload;
  });
}
