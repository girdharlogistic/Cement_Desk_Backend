/**
 * The database. SQLite, on this machine, through Node's built-in `node:sqlite`
 * — no native module to rebuild, no driver to install.
 *
 * This file used to wrap a mysql2 pool against TiDB Cloud. The API it exports
 * has not changed (`q`, `qOne`, `tx`, `Q`), and neither has the `[rows, fields]`
 * tuple every one of the ~230 call sites destructures, so the modules above it
 * were left alone apart from the handful of statements that were MySQL-only.
 * See migrations-sqlite/0001_baseline.sql for the dialect decisions.
 *
 * Three things here are load-bearing and worth reading before changing:
 *
 *  1. **Everything is serialized through one lock.** node:sqlite is
 *     synchronous, but our callers are async and a `tx` callback awaits between
 *     statements. Without the lock, two overlapping transactions would
 *     interleave their statements into one another's BEGIN…COMMIT — SQLite has
 *     a single connection, so there is no second transaction to interleave
 *     *into*. The FIFO below makes a transaction atomic in the way the service
 *     layer already assumes it is. Statements take microseconds, so the queue
 *     does not meaningfully back up at this scale.
 *
 *  2. **Parameters are normalized before binding.** mysql2 accepted booleans,
 *     `undefined` and `Date` objects; node:sqlite throws on the first two and —
 *     worse — silently binds a Date as NULL. Every value goes through
 *     [bindable] so a `?` that used to work still does.
 *
 *  3. **Array parameters expand.** mysql2's `query()` turned `IN (?)` with an
 *     array into `IN (a,b,c)`. A few reporting queries still rely on it, so
 *     [expandArrays] does the same thing, honestly this time — one placeholder
 *     per element, still bound rather than interpolated.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { getConfig } from '../config';
import { nowSql } from '../lib/dates';

let db: DatabaseSync | null = null;
let dbPath = '';

/** Prepared statements are cached by SQL text — the same few hundred repeat forever. */
const stmts = new Map<string, StatementSync>();
const STMT_CACHE_MAX = 500;

export function getDb(): DatabaseSync {
  if (db) return db;
  return openDb(getConfig().SQLITE_PATH);
}

/** Opens (creating if needed) the database file and applies the pragmas. */
export function openDb(path: string): DatabaseSync {
  if (db) return db;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  dbPath = path;
  const d = new DatabaseSync(path);
  // WAL lets a backup or a `sqlite3` shell read while the server writes, and
  // survives a crash without losing committed transactions.
  d.exec('PRAGMA journal_mode = WAL');
  // NORMAL is the documented safe pairing with WAL: a committed transaction can
  // only be lost to an OS/power failure, never to a process crash.
  d.exec('PRAGMA synchronous = NORMAL');
  // Composite foreign keys are the whole tenancy story (§6.1) — they have to be
  // enforced, and SQLite leaves them off unless asked.
  d.exec('PRAGMA foreign_keys = ON');
  // Only matters for outside readers, since we serialize our own access.
  d.exec('PRAGMA busy_timeout = 5000');
  d.exec('PRAGMA temp_store = MEMORY');
  registerCompatFunctions(d);
  db = d;
  return d;
}

/**
 * `UTC_TIMESTAMP(3)` — the one MySQL builtin kept rather than rewritten.
 *
 * It appears in about forty statements, always as "stamp this row now", and it
 * is the single thing SQLite has no drop-in spelling for: `CURRENT_TIMESTAMP`
 * drops the milliseconds that sync cursors are ordered by, and the expression
 * that does work — `strftime('%Y-%m-%d %H:%M:%f','now')` — cannot be embedded
 * in the single-quoted SQL strings those call sites use without escaping every
 * one of them. So it is defined here instead, once, returning exactly the
 * format `nowSql()` produces and the DDL's DEFAULTs write.
 *
 * Only usable in DML. SQLite refuses app-defined functions in DEFAULT, CHECK
 * and index expressions, which is why the schema spells strftime out in full.
 */
function registerCompatFunctions(d: DatabaseSync): void {
  const now = () => nowSql();
  // varargs so both `UTC_TIMESTAMP(3)` and a bare `UTC_TIMESTAMP()` parse. The
  // argument was MySQL's fractional-second precision and is always 3 here.
  d.function('UTC_TIMESTAMP', { varargs: true, deterministic: false }, now);
  d.function('NOW', { varargs: true, deterministic: false }, now);

  // `x REGEXP y` compiles to a call to regexp(y, x). SQLite parses the operator
  // but ships no implementation, so without this the one statement that uses it
  // — ordering party codes numerically, non-numeric last — fails at runtime
  // rather than at build time.
  d.function('regexp', { deterministic: true }, (pattern: unknown, value: unknown) => {
    if (value === null || value === undefined) return null;
    try {
      return new RegExp(String(pattern)).test(String(value)) ? 1 : 0;
    } catch {
      return 0;
    }
  });
}

export function databasePath(): string {
  return dbPath;
}

/** Test-scope override, kept for the name the integration suite imports. */
export function initPoolFromUrl(pathOrUrl: string): DatabaseSync {
  return openDb(pathOrUrl.replace(/^sqlite:(\/\/)?/, '') || ':memory:');
}

export async function closePool(): Promise<void> {
  if (!db) return;
  // Fold the WAL back into the main file so a copy of it is a complete backup.
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* closing anyway */
  }
  stmts.clear();
  db.close();
  db = null;
}

export async function pingDb(): Promise<boolean> {
  try {
    await q('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ the lock

/**
 * A FIFO of waiters. `lock()` resolves when the caller owns the database and
 * hands back the release function; see the header for why this exists.
 */
let locked = false;
const waiters: Array<() => void> = [];

function lock(): Promise<() => void> {
  const release = () => {
    const next = waiters.shift();
    if (next) next();
    else locked = false;
  };
  if (!locked) {
    locked = true;
    return Promise.resolve(release);
  }
  return new Promise((resolve) => waiters.push(() => resolve(release)));
}

// ------------------------------------------------------------- SQL execution

/**
 * mysql2 tolerated values node:sqlite refuses. Booleans and `undefined` throw
 * outright; a Date binds as NULL without complaint, which is the one that would
 * have shipped quietly.
 */
function bindable(v: unknown): null | number | bigint | string | Uint8Array {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return nowSql(v);
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string') return v;
  if (v instanceof Uint8Array) return v;
  if (Buffer.isBuffer(v)) return new Uint8Array(v);
  // Objects reached the JSON columns as objects under mysql2, which stringified
  // them. Those columns are TEXT now, so do it here rather than at each caller.
  return JSON.stringify(v);
}

/**
 * Replaces a `?` whose argument is an array with one placeholder per element,
 * the way mysql2's `query()` did for `IN (?)`. Placeholders inside string
 * literals are skipped, so `WHERE note = '?'` is left alone.
 */
function expandArrays(sql: string, params: unknown[]): { sql: string; params: unknown[] } {
  if (!params.some((p) => Array.isArray(p))) return { sql, params };
  let out = '';
  let arg = 0;
  const flat: unknown[] = [];
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch !== '?') {
      out += ch;
      continue;
    }
    const p = params[arg++];
    if (Array.isArray(p)) {
      // An empty list has to become something that matches nothing rather than
      // `IN ()`, which is a syntax error.
      if (p.length === 0) {
        out += 'NULL';
      } else {
        out += p.map(() => '?').join(',');
        flat.push(...p);
      }
    } else {
      out += '?';
      flat.push(p);
    }
  }
  return { sql: out, params: flat };
}

/** True for statements that hand back rows rather than a change count. */
function returnsRows(sql: string): boolean {
  const head = sql.replace(/^[\s;]*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)?\s*/, '').slice(0, 12).toUpperCase();
  if (/^(SELECT|WITH|PRAGMA|EXPLAIN|VALUES)/.test(head)) return true;
  return /\bRETURNING\b/i.test(sql);
}

function prepared(sql: string): StatementSync {
  const hit = stmts.get(sql);
  if (hit) return hit;
  const st = getDb().prepare(sql);
  // A plain cap rather than an LRU: the working set is a few hundred fixed
  // statements, so the cache fills once and never turns over.
  if (stmts.size >= STMT_CACHE_MAX) stmts.clear();
  stmts.set(sql, st);
  return st;
}

/** The mysql2-shaped result of a write, for the call sites that read it. */
export interface ResultHeader {
  affectedRows: number;
  changedRows: number;
  insertId: number;
  warningStatus: number;
}

function run(sql: string, params: unknown[]): [any, any] {
  const ex = expandArrays(sql, params);
  const bound = ex.params.map(bindable);
  const st = prepared(ex.sql);
  if (returnsRows(ex.sql)) return [st.all(...bound), []];
  const r = st.run(...bound);
  const changes = Number(r.changes);
  const header: ResultHeader = {
    affectedRows: changes,
    changedRows: changes,
    insertId: Number(r.lastInsertRowid),
    warningStatus: 0,
  };
  return [header, undefined];
}

/**
 * What a service receives as `c` inside [tx], and the type the modules import
 * where they used to import mysql2's `PoolConnection`. Both method names are
 * kept because the call sites use both.
 */
export interface Q {
  query<T = any>(sql: string, params?: unknown[]): Promise<[T, any]>;
  execute<T = any>(sql: string, params?: unknown[]): Promise<[T, any]>;
}

/**
 * A handle that runs statements directly, without taking the lock — it is
 * handed out only by [tx], which already holds it for the whole callback.
 */
const inTransaction: Q = {
  query: async (sql, params = []) => run(sql, params) as any,
  execute: async (sql, params = []) => run(sql, params) as any,
};

/**
 * Set for the duration of a transaction, and read by [q]/[qOne]/[exec].
 *
 * The lock is not re-entrant, so a service function that calls the
 * module-level `q()` while a transaction is open would wait for a lock its own
 * caller is holding — a hang, not an error, and only on the code path that
 * happens to nest. Today nothing does (the convention is to pass `c` down),
 * but that is a convention, and the failure mode if someone breaks it is a
 * request that never answers. So the helpers check this instead: inside a
 * transaction they run on it, which is the connection they would have used
 * anyway.
 */
const txDepth = new AsyncLocalStorage<true>();

/** Run a function inside a transaction. Serialized against all other access. */
export async function tx<T>(fn: (c: Q) => Promise<T>): Promise<T> {
  // Already inside one: join it rather than deadlock. Committing here would
  // also end the outer transaction early, leaving the rest of it unprotected.
  if (txDepth.getStore()) return fn(inTransaction);

  const release = await lock();
  const d = getDb();
  // IMMEDIATE takes the write lock at BEGIN instead of at the first write, so a
  // transaction cannot fail partway through for a reason that has nothing to do
  // with what it was trying to do.
  d.exec('BEGIN IMMEDIATE');
  try {
    const out = await txDepth.run(true, () => fn(inTransaction));
    d.exec('COMMIT');
    return out;
  } catch (e) {
    try {
      d.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    release();
  }
}

/** Plain query. Waits for any open transaction; joins one it is already in. */
export async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (txDepth.getStore()) return run(sql, params)[0] as T[];
  const release = await lock();
  try {
    return run(sql, params)[0] as T[];
  } finally {
    release();
  }
}

export async function qOne<T = any>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows.length ? rows[0] : null;
}

/**
 * A write outside a transaction, for the two call sites that read `affectedRows`
 * off the result. Replaces `getPool().query(...)`.
 */
export async function exec(sql: string, params: unknown[] = []): Promise<ResultHeader> {
  if (txDepth.getStore()) return run(sql, params)[0] as ResultHeader;
  const release = await lock();
  try {
    return run(sql, params)[0] as ResultHeader;
  } finally {
    release();
  }
}
