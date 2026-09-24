import { FastifyInstance } from 'fastify';
import { getConfig } from '../../config';
import { TtlCache } from '../../lib/cache';
import { TrackRelease, liveProductionRelease } from '../billing/play';

/**
 * `GET /app/version` — what the newest shipped build is, so a running install
 * can tell the user it is behind.
 *
 * The answer comes from **Play itself**, through the service account that
 * already releases the app. That is the whole point of doing it this way:
 * there is no value to set after a release, no secret to add to CI, and no
 * console field anyone has to remember. The app ships, Play serves it, and
 * within the hour every install knows.
 *
 * An hour of cache because a release happens a few times a month and reading
 * this costs Play an edit transaction. A failure is cached far more briefly —
 * long enough that an outage cannot turn every poll into a Play round trip,
 * short enough that a release is not invisible for an hour after Play comes
 * back.
 */

const OK_TTL = 60 * 60_000;
const FAIL_TTL = 5 * 60_000;

const fresh = new TtlCache<TrackRelease | null>(OK_TTL, 4);
const stale = new TtlCache<TrackRelease | null>(FAIL_TTL, 4);

const KEY = 'production';

async function latest(): Promise<TrackRelease | null> {
  const hit = fresh.get(KEY);
  if (hit !== undefined) return hit;
  const miss = stale.get(KEY);
  if (miss !== undefined) return miss;
  const value = await liveProductionRelease();
  if (value) fresh.set(KEY, value);
  else stale.set(KEY, null);
  return value;
}

export function registerReleaseRoutes(app: FastifyInstance): void {
  /**
   * Unauthenticated, like `/app/sponsor`: it is public information — anyone
   * can read the same version off the Play listing — and the app wants it
   * before it has done anything else.
   */
  app.get('/app/version', async (_req, reply) => {
    const cfg = getConfig();
    void reply.header('cache-control', 'public, max-age=900');
    const release = await latest();
    return {
      android: release
        ? {
            versionCode: release.versionCode,
            versionName: release.versionName,
            url: `https://play.google.com/store/apps/details?id=${encodeURIComponent(cfg.PLAY_PACKAGE_NAME)}`,
          }
        : null,
    };
  });
}
