import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { openDb } from './pool';
import { getConfig } from '../config';

/**
 * Explicit, reviewed SQL migrations (§4.2 — no ORM auto-migration).
 * Files in migrations-sqlite/ run in name order; each is recorded in
 * `_migrations`, and each file is applied inside one transaction.
 *
 * That last part is new and is the whole reason the SQLite directory is
 * separate from the TiDB one rather than a rewrite of it. TiDB auto-commits
 * DDL, so a file that failed halfway left its earlier statements applied and
 * ran again from the top next boot — migration 0009 carries a long comment
 * about what that cost. SQLite runs DDL transactionally, so a failed file
 * leaves nothing behind and the "every statement must be re-runnable"
 * discipline is no longer load-bearing.
 *
 * migrations/ (the MySQL files) is kept as history. Nothing reads it.
 */
export async function runMigrations(migrationsDir?: string): Promise<string[]> {
  const dir = migrationsDir ?? join(__dirname, '..', '..', 'migrations-sqlite');
  const db = openDb(getConfig().SQLITE_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT NOT NULL PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
    )`);

  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map((r: any) => r.name as string),
  );

  const ran: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      // `exec` runs the whole file, which is what the triggers need: their
      // bodies contain semicolons, so splitting on `;` would cut them in half.
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(f);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
    }
    ran.push(f);
  }
  return ran;
}

// CLI entry (npm run migrate)
if (require.main === module) {
  runMigrations()
    .then((ran) => {
      console.log(ran.length ? `Applied migrations:\n  ${ran.join('\n  ')}` : 'No new migrations.');
      process.exit(0);
    })
    .catch((e) => {
      console.error('Migration failed:', (e as Error).message ?? e);
      process.exit(1);
    });
}

