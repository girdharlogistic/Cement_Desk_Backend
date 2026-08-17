import mysql from 'mysql2/promise';
import { getConfig } from '../config';

let pool: mysql.Pool | null = null;

export function getPool(): mysql.Pool {
  if (pool) return pool;
  const cfg = getConfig();
  pool = mysql.createPool({
    host: cfg.TIDB_HOST,
    port: cfg.TIDB_PORT,
    user: cfg.TIDB_USER,
    password: cfg.TIDB_PASSWORD,
    database: cfg.TIDB_DATABASE,
    connectionLimit: cfg.DB_POOL_SIZE,
    waitForConnections: true,
    // Business correctness knobs (§5.7, §11.1):
    dateStrings: true, // DATE/DATETIME come back as raw strings — no TZ conversion ever
    decimalNumbers: false, // DECIMAL comes back as string — converted explicitly at the boundary
    multipleStatements: false,
    namedPlaceholders: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    connectTimeout: 10000,
    ...(cfg.TIDB_TLS ? { ssl: { minVersion: 'TLSv1.2' as const, rejectUnauthorized: true } } : {}),
  });
  setSessionDefaults(pool);
  return pool;
}

/**
 * Session runs at UTC so DATETIME(3) defaults/updates are UTC (§5.7).
 * The `connection` event hands back the *core* (callback-style) connection, not
 * the promise wrapper — calling `.then()/.catch()` on its `query()` result makes
 * mysql2 swallow the command and the connection never completes its first query.
 * The callback form is the only correct one here.
 */
function setSessionDefaults(p: mysql.Pool): void {
  p.on('connection', (conn) => {
    // 30s ceiling on read-only statements so a runaway scan cannot pin a pool slot.
    (conn as any).query("SET time_zone = '+00:00', max_execution_time = 30000", () => {});
  });
}

/** Test-scope override: build a pool from an explicit URL (mysql://user:pass@host:port/db). */
export function initPoolFromUrl(url: string): mysql.Pool {
  if (pool) return pool;
  const u = new URL(url);
  const tls = u.searchParams.get('tls') === 'true';
  pool = mysql.createPool({
    host: u.hostname,
    port: Number(u.port || 4000),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
    connectionLimit: 8,
    waitForConnections: true,
    dateStrings: true,
    decimalNumbers: false,
    bigNumberStrings: true,
    supportBigNumbers: true,
    connectTimeout: 10000,
    ...(tls ? { ssl: { minVersion: 'TLSv1.2' as const, rejectUnauthorized: true } } : {}),
  });
  setSessionDefaults(pool);
  return pool;
}

export type Q =Pick<mysql.PoolConnection, 'query' | 'execute'> | mysql.Pool;

/** Run a function inside a pessimistic transaction (TiDB default since v5.0). */
export async function tx<T>(fn: (c: mysql.PoolConnection) => Promise<T>): Promise<T> {
  const c = await getPool().getConnection();
  try {
    await c.beginTransaction();
    const out = await fn(c);
    await c.commit();
    return out;
  } catch (e) {
    try {
      await c.rollback();
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    c.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function pingDb(): Promise<boolean> {
  try {
    await getPool().query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Plain pooled query. NOTE: mysql2 has no per-query `timeout` option (that is a
 * `mysql`-package feature and is silently ignored), so statement budgets are
 * enforced server-side via `max_execution_time` — see setSessionDefaults.
 */
export async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await getPool().query(sql, params);
  return rows as T[];
}

export async function qOne<T = any>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows.length ? rows[0] : null;
}
