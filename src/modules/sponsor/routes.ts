import { FastifyInstance } from 'fastify';
import { sqlToIso } from '../../lib/dates';
import { readSponsor } from './repo';

/**
 * What the app reads to draw the sponsored card on Home.
 *
 * Unauthenticated on purpose. It carries no user data — it is an advertisement
 * — and the app wants it on the very first frame, before the access token has
 * been refreshed. Requiring a session would mean the card is blank for the
 * second or two that costs, on the one screen where it is meant to be seen.
 *
 * The response is deliberately small and cacheable. Every install fetches it on
 * every resume, so five minutes at the edge is the difference between a trickle
 * and a stampede on a table that changes once a month.
 */
export function registerSponsorRoutes(app: FastifyInstance): void {
  app.get('/app/sponsor', async (_req, reply) => {
    const s = await readSponsor();
    void reply.header('cache-control', 'public, max-age=300');

    // Switched off: say so and send nothing else. The app has its own in-house
    // card for this case, so there is no reason to ship a sponsor's half-edited
    // draft to every phone in the country.
    if (!s.enabled || !s.brand) return { sponsor: null };

    return {
      sponsor: {
        label: s.label,
        brand: s.brand,
        byLine: s.byLine,
        pitch: s.pitch,
        cta: s.cta,
        linkUrl: s.linkUrl,
        imageUrl: s.imageUrl,
        accent: s.accent,
        updatedAt: sqlToIso(s.updatedAt),
      },
    };
  });
}
