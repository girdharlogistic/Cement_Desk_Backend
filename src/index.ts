import { buildApp } from './app';
import { getConfig } from './config';
import { runMigrations } from './db/migrate';
import { startJobs } from './jobs/purge';
import { startBackups } from './jobs/backup';

async function main(): Promise<void> {
  const cfg = getConfig();

  // Apply pending migrations at boot (explicit SQL, no ORM auto-migration — §4.2).
  const applied = await runMigrations();
  if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);

  const app = await buildApp();
  await app.listen({ port: cfg.PORT, host: cfg.HOST });
  if (cfg.ENABLE_JOBS) startJobs();
  startBackups();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('Fatal boot error:', (e as Error).message ?? e);
  process.exit(1);
});
