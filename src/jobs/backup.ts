/**
 * Nightly snapshots of the database file.
 *
 * On TiDB Cloud this did not need writing: the provider kept backups and a
 * point-in-time restore. A local SQLite file has neither, and the whole of a
 * dealer's books now sit on one disk, so the snapshot is the only copy that
 * survives that disk. Treat this as part of the move off TiDB, not as an extra.
 *
 * `VACUUM INTO` rather than `cp`: it takes a consistent snapshot of a live,
 * WAL-mode database without blocking writers and without needing the -wal and
 * -shm files copied alongside at the same instant. The result is a plain,
 * already-compacted database file — open it with sqlite3, or move it back over
 * the original to restore.
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../config';
import { getDb } from '../db/pool';

const PREFIX = 'cementdesk-';
const SUFFIX = '.db';

/** Takes one snapshot and prunes old ones. Returns the file it wrote. */
export function backupNow(): string {
  const cfg = getConfig();
  if (!cfg.SQLITE_BACKUP_DIR) throw new Error('SQLITE_BACKUP_DIR is not set');
  mkdirSync(cfg.SQLITE_BACKUP_DIR, { recursive: true });

  // Colons are legal in a filename but make the path awkward to type and
  // illegal on a Windows machine someone might copy it to.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const target = join(cfg.SQLITE_BACKUP_DIR, `${PREFIX}${stamp}${SUFFIX}`);

  // The path is interpolated, not bound: VACUUM INTO does not take a
  // parameter. It is built from a timestamp and a configured directory, so
  // there is nothing user-supplied in it — but keep it that way.
  getDb().exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  prune(cfg.SQLITE_BACKUP_DIR, cfg.SQLITE_BACKUP_KEEP);
  return target;
}

/** Keeps the newest [keep] snapshots and deletes the rest. */
function prune(dir: string, keep: number): void {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(keep)) {
    try {
      unlinkSync(join(dir, f));
    } catch {
      /* another run got there first */
    }
  }
}

let started = false;

/**
 * Runs one snapshot at boot and then daily.
 *
 * Deliberately not behind ENABLE_JOBS. That flag gates the purge job, which
 * *deletes* rows and is off in production for exactly that reason; a backup is
 * the opposite kind of risk, and tying the two together is how you end up with
 * no backups because someone was being careful about deletes.
 */
export function startBackups(): void {
  if (started) return;
  const cfg = getConfig();
  if (!cfg.SQLITE_BACKUP_DIR) {
    console.warn('[backup] SQLITE_BACKUP_DIR is not set — no snapshots will be taken');
    return;
  }
  started = true;
  const tick = () => {
    try {
      console.log(`[backup] wrote ${backupNow()}`);
    } catch (e) {
      console.error('[backup] failed', (e as Error).message);
    }
  };
  tick();
  setInterval(tick, 24 * 3600_000).unref();
}
