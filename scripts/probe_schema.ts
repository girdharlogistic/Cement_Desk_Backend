/** Ad-hoc schema probe after migrations (dev tool). */
import { getConfig } from '../src/config';
import mysql from 'mysql2/promise';

(async () => {
  const cfg = getConfig();
  const c = await mysql.createConnection({
    host: cfg.TIDB_HOST,
    port: cfg.TIDB_PORT,
    user: cfg.TIDB_USER,
    password: cfg.TIDB_PASSWORD,
    database: cfg.TIDB_DATABASE,
    ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
  });
  const [t] = await c.query('SHOW TABLES');
  const names = (t as any[]).map((x) => Object.values(x)[0]).sort();
  console.log(`tables (${names.length}):`, names.join(', '));
  const [fks] = await c.query(
    "SELECT COUNT(*) AS n FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'",
    [cfg.TIDB_DATABASE],
  );
  console.log('foreign keys created:', (fks as any[])[0].n);
  const [chk] = await c.query('SELECT @@tidb_enable_foreign_key AS fk').catch(() => [[{ fk: 'unknown' }]] as any);
  console.log('tidb_enable_foreign_key:', (chk as any[])[0].fk);
  await c.end();
})().catch((e) => {
  console.error('FAIL', e.message ?? e);
  process.exit(1);
});
