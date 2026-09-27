import { randomInt } from 'crypto';
import { getConfig } from '../../config';
import { exec, q, qOne } from '../../db/pool';
import { nowSql, sqlToIso } from '../../lib/dates';
import { AppError, errors, isDuplicateKey } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { sendMailBestEffort } from '../../lib/mailer';
import { getSubscriptionV2, hasPaid, SubscriptionPurchaseV2 } from '../billing/play';

/**
 * Refer and earn.
 *
 * Every account has a code. A new account types someone's code in *before* its
 * first purchase; once that account has actually paid Play — a free trial is
 * not a payment, see `hasPaid` — the referrer may claim a cash bonus to a UPI
 * ID, and the operator pays it by hand from the console.
 *
 * The rules that keep this from being a money tap, in one place:
 *
 * - One referrer per account, ever (`uk_referrals_referee`), so one purchase
 *   can never pay out twice.
 * - Only before the first Play purchase. An existing subscriber typing a code
 *   in afterwards is not a referral, it is a coupon for money.
 * - Not your own code. (A second account of your own is not something the
 *   server can see — that is what the operator's review in the console is for,
 *   and why nothing is paid automatically.)
 * - Qualifying needs real money at Play. Trials are re-checked by
 *   [recheckPendingReferrals] once they could have converted.
 */

export type ReferralStatus = 'pending' | 'qualified' | 'claimed' | 'paid' | 'rejected';

// No 0/O, 1/I/L: a code is read aloud over the phone and typed off a WhatsApp
// message, and those are the pairs people get wrong.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 7;

export function generateCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** What a user typed, as the code it most likely is: upper case, no spaces or dashes. */
export function normalizeCode(raw: string): string {
  return raw.replace(/[\s-]+/g, '').toUpperCase();
}

/**
 * A UPI virtual payment address: `name@handle`. The handle is a bank or app
 * (`okaxis`, `ybl`, `paytm`); the name part allows dots, dashes and
 * underscores. Lower-cased because UPI treats them case-insensitively and the
 * operator copies it into a payment app by hand.
 */
const UPI_RE = /^[a-z0-9][a-z0-9._-]{0,255}@[a-z][a-z0-9.-]{1,63}$/;

export function normalizeUpi(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  return UPI_RE.test(v) ? v : null;
}

/** `ra•••@gmail.com` — enough for a referrer to recognise who, no more. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '•••';
  const name = email.slice(0, at);
  return `${name.slice(0, Math.min(2, name.length))}•••${email.slice(at)}`;
}

function bonus(): number {
  return getConfig().REFERRAL_BONUS_INR;
}

// ------------------------------------------------------------------ codes

/** The user's code, minted the first time anybody asks for it. */
export async function ensureCode(userId: string): Promise<string> {
  const row = await qOne<{ code: string }>('SELECT code FROM referral_codes WHERE user_id = ?', [
    userId,
  ]);
  if (row) return row.code;
  // 31^7 ≈ 27 billion codes, so a collision is a rarity rather than a loop —
  // but the unique index is the real guarantee, and a retry is cheaper than
  // reasoning about the odds.
  for (let i = 0; i < 5; i++) {
    const code = generateCode();
    try {
      await q('INSERT INTO referral_codes (user_id, code) VALUES (?,?)', [userId, code]);
      return code;
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      // Either the code was taken, or this user's row was inserted by a
      // concurrent request — which one decides whether to try again.
      const mine = await qOne<{ code: string }>(
        'SELECT code FROM referral_codes WHERE user_id = ?',
        [userId],
      );
      if (mine) return mine.code;
    }
  }
  throw new AppError(500, 'INTERNAL', 'Could not create a referral code — try again.');
}

// ------------------------------------------------------------- the app side

export interface MyReferral {
  id: string;
  /** Who was referred: display name, or a masked email. */
  label: string;
  status: ReferralStatus;
  bonusInr: number;
  createdAt: string;
  qualifiedAt: string | null;
  claimedAt: string | null;
  paidAt: string | null;
}

export interface ReferralSummary {
  code: string;
  bonusInr: number;
  /** The programme is on (a non-zero bonus is configured). */
  enabled: boolean;
  /** May this account still type somebody else's code in? */
  canApply: boolean;
  /** Who referred this account, if anyone. */
  referredBy: { label: string } | null;
  referrals: MyReferral[];
  /** Completed and not yet claimed — what the claim form would request. */
  claimableInr: number;
  /** Claimed and waiting for the operator. */
  pendingPayoutInr: number;
  paidInr: number;
}

function label(displayName: string | null, email: string): string {
  const n = (displayName ?? '').trim();
  return n || maskEmail(email);
}

/** Has this account ever held a Play purchase? */
async function hasEverPurchased(userId: string): Promise<boolean> {
  const row = await qOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM entitlements
      WHERE user_id = ? AND (source = 'play' OR purchase_token != '')`,
    [userId],
  );
  return Number(row?.n ?? 0) > 0;
}

export async function referralSummary(userId: string): Promise<ReferralSummary> {
  const code = await ensureCode(userId);
  const rows = await q<any>(
    `SELECT r.*, u.email, u.display_name
       FROM referrals r JOIN users u ON u.id = r.referee_user_id
      WHERE r.referrer_user_id = ?
      ORDER BY r.created_at DESC`,
    [userId],
  );
  const by = await qOne<any>(
    `SELECT u.email, u.display_name
       FROM referrals r JOIN users u ON u.id = r.referrer_user_id
      WHERE r.referee_user_id = ?`,
    [userId],
  );

  const referrals: MyReferral[] = rows.map((r) => ({
    id: r.id,
    label: label(r.display_name, r.email),
    status: r.status,
    // A pending row has no bonus pinned yet; show what it would earn today.
    bonusInr: r.status === 'pending' ? bonus() : Number(r.bonus_inr),
    createdAt: sqlToIso(r.created_at)!,
    qualifiedAt: sqlToIso(r.qualified_at),
    claimedAt: sqlToIso(r.claimed_at),
    paidAt: sqlToIso(r.paid_at),
  }));
  const sum = (s: ReferralStatus) =>
    referrals.filter((r) => r.status === s).reduce((a, r) => a + r.bonusInr, 0);

  const enabled = bonus() > 0;
  return {
    code,
    bonusInr: bonus(),
    enabled,
    canApply: enabled && !by && !(await hasEverPurchased(userId)),
    referredBy: by ? { label: label(by.display_name, by.email) } : null,
    referrals,
    claimableInr: sum('qualified'),
    pendingPayoutInr: sum('claimed'),
    paidInr: sum('paid'),
  };
}

/** Records that [userId] was referred by the owner of [rawCode]. */
export async function applyCode(userId: string, rawCode: string): Promise<void> {
  if (bonus() <= 0) throw errors.businessRule('Referrals are not running right now.');
  const code = normalizeCode(rawCode);
  const owner = await qOne<{ user_id: string; status: string }>(
    `SELECT c.user_id, u.status FROM referral_codes c JOIN users u ON u.id = c.user_id
      WHERE c.code = ?`,
    [code],
  );
  if (!owner || owner.status !== 'active') {
    throw errors.validation('That referral code does not exist. Check it and try again.');
  }
  if (owner.user_id === userId) throw errors.businessRule('You cannot use your own code.');
  if (await hasEverPurchased(userId)) {
    throw errors.businessRule('Referral codes only work before your first premium purchase.');
  }
  try {
    await q(
      `INSERT INTO referrals (id, referrer_user_id, referee_user_id, code, status)
       VALUES (?,?,?,?, 'pending')`,
      [newId(), owner.user_id, userId, code],
    );
  } catch (e) {
    if (isDuplicateKey(e)) throw errors.businessRule('A referral code is already applied to this account.');
    throw e;
  }
}

/** The referrer asks to be paid everything that has qualified, to [rawUpi]. */
export async function claimBonus(userId: string, rawUpi: string): Promise<number> {
  const upi = normalizeUpi(rawUpi);
  if (!upi) throw errors.validation('Enter a valid UPI ID, like name@okaxis.');
  const res = await exec(
    `UPDATE referrals SET status = 'claimed', upi_id = ?, claimed_at = ?
      WHERE referrer_user_id = ? AND status = 'qualified'`,
    [upi, nowSql(), userId],
  );
  const n = res.affectedRows ?? 0;
  if (n === 0) throw errors.businessRule('There is no completed referral to claim yet.');
  return n;
}

// ---------------------------------------------------------- qualification

/**
 * Called by `/billing/verify` after a purchase is granted. Remembers the
 * purchase on the referee's pending row and qualifies it if Play has been
 * paid. Never throws — a referral hiccup must not fail somebody's purchase.
 */
export async function noteReferralPurchase(
  refereeUserId: string,
  purchaseToken: string,
  purchase: SubscriptionPurchaseV2,
  planPeriod: string,
): Promise<void> {
  try {
    const row = await qOne<{ id: string }>(
      `SELECT id FROM referrals WHERE referee_user_id = ? AND status = 'pending'`,
      [refereeUserId],
    );
    if (!row) return;
    await q(`UPDATE referrals SET purchase_token = ?, plan_period = ? WHERE id = ?`, [
      purchaseToken,
      planPeriod,
      row.id,
    ]);
    if (hasPaid(purchase)) await qualify(row.id);
  } catch (e) {
    console.error('[referral] could not note purchase', (e as Error).message);
  }
}

/** pending → qualified, pinning today's bonus, and tells the referrer. */
async function qualify(id: string): Promise<boolean> {
  const res = await exec(
    `UPDATE referrals SET status = 'qualified', bonus_inr = ?, qualified_at = ?
      WHERE id = ? AND status = 'pending'`,
    [bonus(), nowSql(), id],
  );
  if (!res.affectedRows) return false;
  const who = await qOne<{ email: string; bonus_inr: number }>(
    `SELECT u.email, r.bonus_inr FROM referrals r JOIN users u ON u.id = r.referrer_user_id
      WHERE r.id = ?`,
    [id],
  );
  if (who) {
    // There is no push-token table to reach one phone, so mail is how the
    // referrer learns the form has appeared.
    sendMailBestEffort(
      who.email,
      `Your ₹${who.bonus_inr} Cement Desk referral bonus is ready`,
      `Someone you referred has just subscribed to Cement Desk Premium.\n\n` +
        `Open the app → More → Refer & earn, and enter your UPI ID to claim ` +
        `₹${who.bonus_inr}. It reaches you within 24–48 hours.\n\n— Cement Desk`,
    );
  }
  return true;
}

/**
 * Pending referrals whose referee started a free trial: asks Play again
 * whether the trial has turned into a payment. There is no RTDN webhook, and
 * the app only re-verifies a purchase it has not completed — so without this a
 * trial that converts would never be noticed.
 */
export async function recheckPendingReferrals(): Promise<{ checked: number; qualified: number }> {
  if (!getConfig().PLAY_SA_KEY_FILE) return { checked: 0, qualified: 0 };
  const rows = await q<{ id: string; purchase_token: string }>(
    `SELECT id, purchase_token FROM referrals
      WHERE status = 'pending' AND purchase_token != ''
      ORDER BY created_at ASC LIMIT 500`,
  );
  let qualified = 0;
  for (const r of rows) {
    try {
      const p = await getSubscriptionV2(r.purchase_token);
      if (hasPaid(p) && (await qualify(r.id))) qualified++;
    } catch (e) {
      // One bad token (refunded, revoked) must not stop the rest.
      console.error(`[referral] recheck ${r.id} failed: ${(e as Error).message}`);
    }
  }
  return { checked: rows.length, qualified };
}

let started = false;
/**
 * Not behind ENABLE_JOBS: that flag guards the destructive purge, and is off in
 * production. This only reads Play and moves money-owed rows forward.
 */
export function startReferralChecks(): void {
  if (started || !getConfig().PLAY_SA_KEY_FILE) return;
  started = true;
  const tick = () =>
    recheckPendingReferrals().then(
      (r) => r.checked && console.log('[referral] recheck', r),
      (e) => console.error('[referral] recheck failed', (e as Error).message),
    );
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 6 * 3600_000).unref();
}

// ---------------------------------------------------------- the console side

export interface ConsoleReferral {
  id: string;
  status: ReferralStatus;
  bonusInr: number;
  code: string;
  referrerId: string;
  referrerEmail: string;
  refereeId: string;
  refereeEmail: string;
  planPeriod: string;
  upiId: string;
  payoutRef: string;
  note: string;
  createdAt: string;
  qualifiedAt: string | null;
  claimedAt: string | null;
  paidAt: string | null;
}

export async function listReferrals(): Promise<ConsoleReferral[]> {
  const rows = await q<any>(
    `SELECT r.*, a.email AS referrer_email, b.email AS referee_email
       FROM referrals r
       JOIN users a ON a.id = r.referrer_user_id
       JOIN users b ON b.id = r.referee_user_id
      ORDER BY CASE r.status WHEN 'claimed' THEN 0 WHEN 'qualified' THEN 1
                             WHEN 'pending' THEN 2 ELSE 3 END,
               r.updated_at DESC
      LIMIT 1000`,
  );
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    bonusInr: Number(r.bonus_inr),
    code: r.code,
    referrerId: r.referrer_user_id,
    referrerEmail: r.referrer_email,
    refereeId: r.referee_user_id,
    refereeEmail: r.referee_email,
    planPeriod: r.plan_period,
    upiId: r.upi_id,
    payoutRef: r.payout_ref,
    note: r.note,
    createdAt: sqlToIso(r.created_at)!,
    qualifiedAt: sqlToIso(r.qualified_at),
    claimedAt: sqlToIso(r.claimed_at),
    paidAt: sqlToIso(r.paid_at),
  }));
}

/** claimed → paid. Only a claimed row has a UPI ID to have paid to. */
export async function markPaid(id: string, payoutRef: string): Promise<void> {
  const res = await exec(
    `UPDATE referrals SET status = 'paid', paid_at = ?, payout_ref = ?
      WHERE id = ? AND status = 'claimed'`,
    [nowSql(), payoutRef, id],
  );
  if (!res.affectedRows) throw errors.businessRule('Only a claimed referral can be marked paid.');
}

/** Anything not yet paid can be refused — a self-referral, a refunded purchase. */
export async function rejectReferral(id: string, note: string): Promise<void> {
  const res = await exec(
    `UPDATE referrals SET status = 'rejected', note = ?
      WHERE id = ? AND status IN ('pending','qualified','claimed')`,
    [note, id],
  );
  if (!res.affectedRows) throw errors.businessRule('That referral is already paid or rejected.');
}
