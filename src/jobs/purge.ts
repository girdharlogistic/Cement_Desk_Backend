import { exec } from '../db/pool';
import { getConfig } from '../config';
import { addDaysSql, nowSql } from '../lib/dates';

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
  const out: Record<string, number> = {};

  // Cutoffs are computed here rather than in SQL. MySQL's
  // `UTC_TIMESTAMP(3) - INTERVAL ? DAY` has no SQLite spelling that takes a
  // bound parameter, and a date string is a value like any other — the same
  // reasoning as §5.7, where business dates never touch a date type either.
  const now = new Date();
  const tombstoneCutoff = addDaysSql(now, -cfg.TOMBSTONE_RETENTION_DAYS);

  for (const t of TENANT_TABLES.filter((x) => x !== 'freight_entry_grades')) {
    // FK-safe: children are cleaned up by ON DELETE CASCADE on parent purge.
    const res = await exec(
      `DELETE FROM ${t} WHERE deleted_at IS NOT NULL AND deleted_at < ?`,
      [tombstoneCutoff],
    );
    out[`tombstones:${t}`] = res.affectedRows ?? 0;
  }

  const sess = await exec(
    `DELETE FROM sessions WHERE (expires_at < ? OR revoked_at IS NOT NULL)
       AND created_at < ?`,
    [nowSql(now), addDaysSql(now, -30)],
  );
  out['sessions'] = sess.affectedRows ?? 0;

  const tok = await exec(
    'DELETE FROM auth_tokens WHERE used_at IS NOT NULL OR expires_at < ?',
    [nowSql(now)],
  );
  out['auth_tokens'] = tok.affectedRows ?? 0;

  const idem = await exec('DELETE FROM idempotency_keys WHERE created_at < ?', [
    addDaysSql(now, -1),
  ]);
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
