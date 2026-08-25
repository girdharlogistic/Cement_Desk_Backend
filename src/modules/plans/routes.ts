import { FastifyInstance } from 'fastify';
import { authenticate } from '../../plugins/guards';
import { listPlans } from './repo';
import { entitlementOf } from './service';

/**
 * What the app reads to draw its paywall and to know what it may do.
 *
 * Note the absence of a price anywhere in these responses. The app takes the
 * `sku` to Play Billing and asks it what this costs — which is the only answer
 * that is ever right, because it is the one the user will actually be charged,
 * in their own currency, including whatever promotion Play is running for them.
 * A price echoed from here could only ever be a second opinion.
 */
export function registerPlanRoutes(app: FastifyInstance): void {
  /**
   * The offer. Hidden plans are left out — retiring a price means it stops
   * being offered, not that it stops working for the people who bought it.
   *
   * `authenticate` rather than `authenticateVerified`: someone who has not
   * confirmed their email is stuck at the gate anyway, and a paywall that
   * cannot even name its plans is a worse dead end than one that can.
   */
  app.get('/plans', { preHandler: [authenticate] }, async () => {
    const plans = await listPlans(false);
    return {
      plans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        sku: p.sku,
        period: p.period,
        features: p.features,
      })),
    };
  });

  /**
   * What this user may do. The app caches this on disk and keeps trusting it
   * while offline — a dealer in a godown with no signal must not lose features
   * they have paid for, so the client, not this route, decides how stale is
   * too stale.
   */
  app.get('/me/entitlement', { preHandler: [authenticate] }, async (req) => {
    const e = await entitlementOf(req.userId);
    return {
      entitlement: {
        planId: e.planId,
        planName: e.planName,
        source: e.source,
        status: e.status,
        expiresAt: e.expiresAt,
        features: e.features,
      },
    };
  });
}
