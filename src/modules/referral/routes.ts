import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { enforceLimit } from '../../lib/limiter';
import { parse } from '../../lib/validate';
import { authenticateVerified } from '../../plugins/guards';
import { applyCode, claimBonus, referralSummary } from './service';

const ApplyInput = z.object({ code: z.string().trim().min(3).max(32) });
const ClaimInput = z.object({ upiId: z.string().trim().min(3).max(320) });

/**
 * The app's three referral calls. See `service.ts` for the rules; the routes
 * only authenticate, rate-limit and answer with the fresh summary so the
 * screen redraws from one source.
 */
export function registerReferralRoutes(app: FastifyInstance): void {
  app.get('/me/referral', { preHandler: [authenticateVerified] }, async (req) => {
    return { referral: await referralSummary(req.userId) };
  });

  app.post('/me/referral/apply', { preHandler: [authenticateVerified] }, async (req) => {
    // Codes are short enough to guess at; ten tries an hour is plenty for a
    // typo and useless for walking the space.
    enforceLimit(`referral:apply:${req.userId}`, 10, 3600_000);
    const { code } = parse(ApplyInput, req.body);
    await applyCode(req.userId, code);
    return { referral: await referralSummary(req.userId) };
  });

  app.post('/me/referral/claim', { preHandler: [authenticateVerified] }, async (req) => {
    enforceLimit(`referral:claim:${req.userId}`, 10, 3600_000);
    const { upiId } = parse(ClaimInput, req.body);
    const claimed = await claimBonus(req.userId, upiId);
    req.log.info({ userId: req.userId, claimed }, 'referral bonus claimed');
    return { referral: await referralSummary(req.userId) };
  });
}
