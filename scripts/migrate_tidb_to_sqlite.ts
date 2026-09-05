/**
 * One-off: copy everything out of TiDB Cloud into the local SQLite file.
 *
 *   npx tsx scripts/migrate_tidb_to_sqlite.ts [--force]
 *
 * Run once, on 2026-09-05, to leave TiDB's free tier behind. It is kept in the
 * repo rather than deleted because "how did the data get here" is a question
 * that gets asked long after the answer is obvious, and because it is the only
 * written-down mapping between the two schemas.
 *
 * What it does:
 *   1. runs the SQLite migrations, so the target schema exists;
 *   2. refuses to run if the target already holds rows, unless --force;
 *   3. copies every table in dependency order, inside one transaction;
 *   4. checks every table's row count against the source;
 *   5. runs PRAGMA foreign_key_check.
 *
 * Steps 4 and 5 are the point. A copy that half-worked and said nothing is
 * worse than one that failed, because the failure is discovered by a dealer
 * with a missing month of vouchers.
 *
 * Source credentials still come from the TIDB_* variables in .env. They are no
 * longer read by the server, only by this file.
 */
import mysql from 'mysql2/promise';
import { openDb, closePool, databasePath } from '../src/db/pool';
import { runMigrations } from '../src/db/migrate';
import { getConfig } from '../src/config';

/**
 * Parents before children. Not merely tidy: `PRAGMA foreign_keys` is off during
 * the copy (a self-referencing order would otherwise be impossible for tables
 * TiDB never enforced), but this order means the check at the end is testing
 * the data rather than the insertion sequence.
 */
const TABLES = [
  'users',
  'firms',
  'firm_members',
  'firm_counters',
  'sessions',
  'auth_tokens',
  'parties',
  'locations',
  'grades',
  'party_routes',
  'freight_entries',
  'freight_entry_grades',
  'opening_baselines',
  'opening_baseline_stock',
  'opening_baseline_party',
  'stock_days',
  'stock_receipts',
  'stock_day_cells',
  'companies',
  'sources',
  'purchases',
  'purchase_payments',
  'scheme_folders',
  'schemes',
  'scheme_slabs',
  'scheme_premium_grades',
  'scheme_grades',
  'claims',
  'claim_credit_notes',
  'plans',
  'entitlements',
  'app_sponsor',
  'sync_state',
  'idempotency_keys',
] as const;

/**
 * Columns SQLite computes for itself. Selecting one from TiDB and trying to
 * insert it is an error, not a no-op.
 */
const GENERATED: Record<string, string[]> = {
  freight_entries: ['serial_live'],
};

/** mysql2's row values -> what node:sqlite will bind. */
function convert(v: unknown): null | number | bigint | string | Uint8Array {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Buffer.isBuffer(v)) return new Uint8Array(v);
  if (v instanceof Uint8Array) return v;
  // A JSON column. mysql2 parses those into objects; the SQLite column is TEXT
  // and every reader already handles a string, so hand it back the way it was
  // stored rather than the way mysql2 chose to present it.
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const cfg = getConfig() as any;

  for (const k of ['TIDB_HOST', 'TIDB_USER', 'TIDB_PASSWORD', 'TIDB_DATABASE']) {
    if (!process.env[k]) throw new Error(`${k} is not set — this script reads the old database directly`);
  }

  const src = await mysql.createConnection({
    host: process.env.TIDB_HOST,
    port: Number(process.env.TIDB_PORT ?? 4000),
    user: process.env.TIDB_USER,
    password: process.env.TIDB_PASSWORD,
    database: process.env.TIDB_DATABASE,
    // The same correctness knobs the server used to run with: dates and
    // decimals arrive as the strings they were stored as, with no timezone
    // conversion and no float rounding on the way out.
    dateStrings: true,
    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    ...(process.env.TIDB_TLS === 'false'
      ? {}
      : { ssl: { minVersion: 'TLSv1.2' as const, rejectUnauthorized: true } }),
  });

  const applied = await runMigrations();
  const db = openDb(cfg.SQLITE_PATH);
  console.log(`target : ${databasePath()}`);
  console.log(`schema : ${applied.length ? applied.join(', ') : 'already present'}`);
  console.log(`source : ${process.env.TIDB_HOST}/${process.env.TIDB_DATABASE}\n`);

  // `app_sponsor` is seeded by the migration itself (one disabled row), so a
  // fresh database is not literally empty. The question this guard is really
  // asking is whether there are accounts in here already.
  const occupied = TABLES.filter(
    (t) => t !== 'app_sponsor' && (db.prepare(`SELECT COUNT(*) AS n FROM \`${t}\``).get() as any).n > 0,
  );
  if (occupied.length && !force) {
    throw new Error(
      `target is not empty (${occupied.join(', ')}). Re-run with --force to replace its contents.`,
    );
  }

  // Off for the duration: TiDB only gained FK enforcement partway through this
  // schema's life, so the source may hold rows that never satisfied the
  // constraints they are declared under. Those are reported at the end rather
  // than aborting a copy 30 tables in.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');

  const copied: Record<string, number> = {};
  try {
    // Always, not just under --force: the migration seeds one app_sponsor row,
    // and the copy is meant to be a replacement rather than a merge. Children
    // first, so the deletes do not depend on cascades being on.
    for (const t of [...TABLES].reverse()) db.exec(`DELETE FROM \`${t}\``);

    for (const t of TABLES) {
      const [rows] = await src.query<any[]>(`SELECT * FROM \`${t}\``);
      copied[t] = rows.length;
      if (!rows.length) {
        console.log(`  ${t.padEnd(24)} 0`);
        continue;
      }

      const skip = GENERATED[t] ?? [];
      const cols = Object.keys(rows[0]).filter((c) => !skip.includes(c));
      const stmt = db.prepare(
        `INSERT INTO \`${t}\` (${cols.map((c) => `\`${c}\``).join(',')})
         VALUES (${cols.map(() => '?').join(',')})`,
      );
      for (const r of rows) stmt.run(...cols.map((c) => convert(r[c])));
      console.log(`  ${t.padEnd(24)} ${rows.length}`);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  // ------------------------------------------------------------- verification
  console.log('\nverifying row counts…');
  let mismatched = 0;
  for (const t of TABLES) {
    const [[srcRow]] = await src.query<any[]>(`SELECT COUNT(*) AS n FROM \`${t}\``);
    const dst = (db.prepare(`SELECT COUNT(*) AS n FROM \`${t}\``).get() as any).n;
    const want = Number(srcRow.n);
    if (want !== Number(dst)) {
      console.error(`  MISMATCH ${t}: TiDB ${want} -> SQLite ${dst}`);
      mismatched++;
    }
  }
  console.log(mismatched ? `  ${mismatched} table(s) differ` : '  all tables match');

  const violations = db.prepare('PRAGMA foreign_key_check').all() as any[];
  if (violations.length) {
    console.error(`\n${violations.length} foreign-key violation(s) carried over from TiDB:`);
    for (const v of violations.slice(0, 20)) {
      console.error(`  ${v.table} row ${v.rowid} -> ${v.parent}`);
    }
  } else {
    console.log('foreign keys: clean');
  }

  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('ANALYZE');
  await src.end();
  await closePool();

  const total = Object.values(copied).reduce((a, b) => a + b, 0);
  console.log(`\n${total} rows copied.`);
  if (mismatched || violations.length) process.exit(1);
}

main().catch((e) => {
  console.error('\nmigration failed:', (e as Error).message ?? e);
  process.exit(1);
});
