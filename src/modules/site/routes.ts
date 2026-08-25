import { FastifyInstance } from 'fastify';
import { renderLandingPage } from './page';

/**
 * The public landing page, at `/`.
 *
 * Served from memory — it changes by release, not by request, so a rebuild is
 * cheap and caching it long is safe. Public and unauthenticated on purpose:
 * this is the URL the Play listing sends strangers to.
 */
export function registerSiteRoutes(app: FastifyInstance): void {
  app.get('/', async (_req, reply) => {
    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'public, max-age=300')
      .send(renderLandingPage());
  });
}
