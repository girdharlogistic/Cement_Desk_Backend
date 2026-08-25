import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getConfig } from '../../config';
import { AppError, errors } from '../../lib/errors';
import { isoToSql } from '../../lib/dates';
import { parse } from '../../lib/validate';
import { authenticate } from '../../plugins/guards';
import { listPlans, readEntitlementByToken, upsertEntitlement } from '../plans/repo';
import { entitlementOf, invalidateEntitlement } from '../plans/service';
import {
  acknowledgeSubscription,
  entitlementStatus,
  getSubscriptionV2,
  pickPlan,
  PlayApiError,
} from './play';

/**
 * Turning a Play purchase into an entitlement.
 *
 * The order of operations is the load-bearing part:
 *
 * 1. **Anti-sharing first.** A token already recorded against another user is
 *    refused before Play is ever asked — a shared token gets no information
 *    from us, not even whether it is valid.
 * 2. **Play is the only source of truth.** The token is verified server-side;
 *    anything the phone claims about a purchase is a claim until then.
 * 3. **Acknowledge before granting.** Play auto-refunds an unacknowledged
 *    purchase after three days. Granting first and acknowledging later loses
 *    that revenue to a crash between the two. Idempotent both sides: a retry
 *    of this whole route re-reads ACKNOWLEDGED and wishes it luck.
 */

// Play tokens are well under the column's VARCHAR(255); the cap is so a
// nonsense body fails here rather than at the database.
const VerifyInput = z.object({ purchaseToken: z.string().min(1).max(255) });

function playUnavailable(message: string): AppError {
  return new AppError(502, 'PLAY_UNAVAILABLE', message);
}

export function registerBillingRoutes(app: FastifyInstance): void {
  /**
   * `authenticate`, not `authenticateVerified`: someone mid-signup can already
   * have been charged (Play does not know about our email gate), and owning a
   * verified purchase with an unverified email should not be a dead end that
   * keeps their money and grants nothing. What they can *do* afterwards is
   * still gated as usual.
   */
  app.post('/billing/verify', { preHandler: [authenticate] }, async (req) => {
    const cfg = getConfig();
    if (!cfg.PLAY_SA_KEY_FILE) {
      throw errors.validation('Billing is not configured on this server.');
    }
    const { purchaseToken } = parse(VerifyInput, req.body);

    // 1. Anti-sharing.
    const holder = await readEntitlementByToken(purchaseToken);
    if (holder && holder.userId !== req.userId) {
      throw new AppError(
        409,
        'PURCHASE_ALREADY_LINKED',
        'This purchase is already linked to another account.',
      );
    }

    // 2. Play is the only source of truth.
    let purchase;
    try {
      purchase = await getSubscriptionV2(purchaseToken);
    } catch (e) {
      // 404/410: no such token. 400: Play rejected the token's form ("Invalid
      // Value") — for a user that is the same answer, not a retryable outage.
      if (e instanceof PlayApiError && (e.status === 400 || e.status === 404 || e.status === 410)) {
        throw errors.validation('Play does not recognise that purchase token.');
      }
      throw playUnavailable('Could not reach Google Play to check the purchase — try again.');
    }

    const item = purchase.lineItems?.[0];
    if (!item || item.productId !== cfg.PLAY_PRODUCT_ID) {
      throw errors.validation('That purchase is not one of our products.');
    }

    // 3. Acknowledge before granting.
    if (purchase.acknowledgementState !== 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED') {
      try {
        await acknowledgeSubscription(purchaseToken);
      } catch {
        throw playUnavailable('Google Play could not acknowledge the purchase — try again.');
      }
    }

    const status = entitlementStatus(purchase);
    if (!status) {
      throw errors.validation(
        `That purchase is not active right now (${purchase.subscriptionState ?? 'unknown state'}).`,
      );
    }
    const expiresAtSql = isoToSql(item.expiryTime);
    if (!expiresAtSql) {
      throw playUnavailable('Play returned no expiry for the purchase — try again.');
    }

    // Retired plans included: whoever bought one keeps it renewing.
    const plan = pickPlan(await listPlans(true), item.productId, item.offerDetails?.basePlanId);
    if (!plan) {
      throw new AppError(
        500,
        'INTERNAL',
        'No plan matches this Play product — create one in the console first.',
      );
    }

    await upsertEntitlement({
      userId: req.userId,
      planId: plan.id,
      source: 'play',
      status,
      expiresAtSql,
      purchaseToken,
      note: '',
    });
    invalidateEntitlement(req.userId);

    // Fresh from the database: the caller unlocks on this response, so it must
    // not be the entitlement that was cached before the purchase.
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
