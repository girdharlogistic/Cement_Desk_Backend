import { getPool } from '../db/pool';
import { getConfig } from '../config';

const TENANT_TABLES = [
  'freight_entry_grades', // hard-purged via parent cascade, listed defensively last-priority
  'parties', 'locations', 'grades', 'party_routes', 'freight_entries', 'opening_baselines',
  'stock_days', 'companies', 'sources', 'purchases', 'schemes', 'claims',
];

/**
 * Scheduled maintenance jobs (§13.3). Intervals: tokens hourly, others daily.
 * Hard deletes of tombstoned parents cascade to owned child tables via FK (§6.1).
 */
export async function runPurgeJobs(): Promise<Record<string, number>> {
  const cfg = getConfig();
  const pool = getPool();
  const out: Record<string, number> = {};

  for (const t of TENANT_TABLES.filter((x) => x !== 'freight_entry_grades')) {
    // FK-safe: children are cleaned up by ON DELETE CASCADE on parent purge.
    const [res]: any = await pool.query(
      `DELETE FROM ${t} WHERE deleted_at IS NOT NULL AND deleted_at < UTC_TIMESTAMP(3) - INTERVAL ? DAY`,
      [cfg.TOMBSTONE_RETENTION_DAYS],
    );
    out[`tombstones:${t}`] = res.affectedRows ?? 0;
  }

  const [sess]: any = await pool.query(
    `DELETE FROM sessions WHERE (expires_at < UTC_TIMESTAMP(3) OR revoked_at IS NOT NULL)
       AND created_at < UTC_TIMESTAMP(3) - INTERVAL 30 DAY`,
  );
  out['sessions'] = sess.affectedRows ?? 0;

  const [tok]: any = await pool.query(
    'DELETE FROM auth_tokens WHERE used_at IS NOT NULL OR expires_at < UTC_TIMESTAMP(3)',
  );
  out['auth_tokens'] = tok.affectedRows ?? 0;

  const [idem]: any = await pool.query(
    'DELETE FROM idempotency_keys WHERE created_at < UTC_TIMESTAMP(3) - INTERVAL 1 DAY',
  );
  out['idempotency_keys'] = idem.affectedRows ?? 0;

  return out;
}

let started = false;
export function startJobs(): void {
  if (started) return;
  started = true;
  const tick = () =>
    runPurgeJobs().then(
      (r) => console.log('[jobs] purge complete', r),
      (e) => console.error('[jobs] purge failed', (e as Error).message),
    );
  void tick();
  setInterval(tick, 6 * 3600_000).unref(); // every 6h covers all cadences conservatively
}
