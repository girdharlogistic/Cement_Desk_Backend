import { q } from '../../db/pool';

/**
 * Live row counts per sync entity, for a client that is about to restore a firm
 * onto a fresh device and wants to show real progress instead of a spinner.
 *
 * Deliberately counts only live rows (`deleted_at IS NULL`): a first pull starts
 * from an empty cursor, and the server does not send tombstones for records the
 * device never had. Counting them would inflate the denominator and leave the
 * bar stuck short of the end.
 *
 * The keys match the `changes` keys in `pull()` exactly, because the client uses
 * them to pair a total with the records it has applied. Adding an entity to the
 * pull without adding it here leaves that entity's step at "0 of 0" — harmless,
 * but the progress bar stops being the whole truth.
 */
const TABLES: Record<string, string> = {
  parties: 'parties',
  locations: 'locations',
  grades: 'grades',
  routes: 'party_routes',
  companies: 'companies',
  sources: 'sources',
  freightEntries: 'freight_entries',
  baseline: 'opening_baselines',
  stockDays: 'stock_days',
  purchases: 'purchases',
  schemes: 'schemes',
  claims: 'claims',
};

export interface CountsResult {
  counts: Record<string, number>;
  total: number;
}

export async function counts(firmId: string): Promise<CountsResult> {
  // One statement per table, but they are all covered by the firm_id prefix of
  // each table's primary key, so this is a dozen index counts — cheap enough to
  // run before every restore.
  const entries = await Promise.all(
    Object.entries(TABLES).map(async ([entity, table]) => {
      const rows = await q<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE firm_id = ? AND deleted_at IS NULL`,
        [firmId],
      );
      return [entity, Number(rows[0]?.n ?? 0)] as const;
    }),
  );
  const out: Record<string, number> = {};
  let total = 0;
  for (const [entity, n] of entries) {
    out[entity] = n;
    total += n;
  }
  return { counts: out, total };
}
