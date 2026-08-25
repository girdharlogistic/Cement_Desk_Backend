import { FastifyInstance } from 'fastify';

/**
 * `/app-ads.txt` — the IAB file that tells ad buyers who is allowed to sell
 * this app's inventory.
 *
 * Google finds it by taking the **developer website** off the Play Store
 * listing and fetching `/app-ads.txt` from its root, so this has to be served
 * from the same origin that listing points at, unauthenticated, as plain text.
 *
 * It matters more than it looks: without a crawlable app-ads.txt most
 * programmatic demand will not bid at all, because it cannot verify that the
 * seller is really us. An app with the file missing and one with it wrong look
 * the same from here — both simply earn much less.
 *
 * The publisher id is deliberately in the code rather than the environment. It
 * is public by construction: it ships inside the APK as the AdMob app id and is
 * meant to be read off this URL by anyone. Keeping it here means it cannot go
 * missing on a fresh deploy, and it sits next to the comment explaining that it
 * must match `lib/ads/ad_ids.dart` in the app.
 */

/** The `pub-…` half of the AdMob app id. */
const PUBLISHER_ID = 'pub-7583807056478714';

/**
 * `f08c47fec0942fa0` is Google's own certification-authority id, the same for
 * every publisher — it identifies AdMob, not us.
 */
const BODY = `google.com, ${PUBLISHER_ID}, DIRECT, f08c47fec0942fa0\n`;

export function registerAdsTxtRoute(app: FastifyInstance): void {
  app.get('/app-ads.txt', async (_req, reply) =>
    reply
      .code(200)
      .header('content-type', 'text/plain; charset=utf-8')
      // Google re-crawls this every few weeks; a day of caching is plenty and
      // keeps a crawler from being the reason the API pool is busy.
      .header('cache-control', 'public, max-age=86400')
      .header('x-content-type-options', 'nosniff')
      .send(BODY),
  );
}
