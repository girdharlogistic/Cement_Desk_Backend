import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import mysql from 'mysql2/promise';
import { getConfig } from '../config';

/**
 * Explicit, reviewed SQL migrations (§4.2 — no ORM auto-migration).
 * Files in migrations/ run in name order; each is recorded in `_migrations`.
 * TiDB DDL auto-commits (non-transactional), so statements in one file are run
 * sequentially and the file is marked applied only when all succeed.
 */
export async function runMigrations(migrationsDir?: string): Promise<string[]> {
  const cfg = getConfig();
  const dir = migrationsDir ?? join(__dirname, '..', '..', 'migrations');

  // Connect without a database selected so we can create it.
  const conn = await mysql.createConnection({
    host: cfg.TIDB_HOST,
    port: cfg.TIDB_PORT,
    user: cfg.TIDB_USER,
    password: cfg.TIDB_PASSWORD,
    multipleStatements: false,
    ...(cfg.TIDB_TLS ? { ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true } } : {}),
  });

  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${cfg.TIDB_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
    );
    await conn.query(`USE \`${cfg.TIDB_DATABASE}\``);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name VARCHAR(255) NOT NULL PRIMARY KEY,
        applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      )`);

    const files = readdirSync(dir)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    const [appliedRows] = await conn.query('SELECT name FROM _migrations');
    const applied = new Set((appliedRows as any[]).map((r) => r.name));

    const ran: string[] = [];
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = readFileSync(join(dir, f), 'utf8');
      for (const stmt of splitStatements(sql)) {
        await conn.query(stmt);
      }
      await conn.query('INSERT INTO _migrations (name) VALUES (?)', [f]);
      ran.push(f);
    }
    return ran;
  } finally {
    await conn.end();
  }
}

function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) =>
      s
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((s) => s.length > 0);
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
