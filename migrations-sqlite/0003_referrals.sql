-- Refer-and-earn: a user shares their code, a new user enters it before
-- buying, and once that new user has actually *paid* Play (a free trial is not
-- a payment) the referrer can claim a cash bonus to a UPI ID. The operator pays
-- it by hand from the console and marks it paid there.
--
-- One code per user, minted lazily the first time they open the screen, so
-- accounts that never refer anybody never get a row.
CREATE TABLE referral_codes (
  user_id    TEXT NOT NULL PRIMARY KEY,
  code       TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  CONSTRAINT fk_refcode_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uk_referral_codes_code ON referral_codes (code);

-- One row per referred account — `referee_user_id` is UNIQUE because an
-- account can only ever have been referred by one person, which is also what
-- stops the bonus being paid twice for the same purchase.
--
-- status:
--   pending   code applied; no paid purchase seen yet (or still in trial)
--   qualified the referee has paid — the referrer may now claim
--   claimed   the referrer submitted a UPI ID; waiting for the operator
--   paid      the operator sent the money
--   rejected  the operator refused it (self-referral, refund, …)
--
-- `bonus_inr` is copied from config when the row qualifies, so changing the
-- offer later never changes what somebody was already promised.
CREATE TABLE referrals (
  id               TEXT NOT NULL PRIMARY KEY,
  referrer_user_id TEXT NOT NULL,
  referee_user_id  TEXT NOT NULL,
  code             TEXT NOT NULL COLLATE NOCASE,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','qualified','claimed','paid','rejected')),
  bonus_inr        INTEGER NOT NULL DEFAULT 0,
  purchase_token   TEXT NOT NULL DEFAULT '',
  plan_period      TEXT NOT NULL DEFAULT '',
  upi_id           TEXT NOT NULL DEFAULT '',
  payout_ref       TEXT NOT NULL DEFAULT '',
  note             TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  qualified_at     TEXT,
  claimed_at       TEXT,
  paid_at          TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  CONSTRAINT fk_ref_referrer FOREIGN KEY (referrer_user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ref_referee  FOREIGN KEY (referee_user_id)  REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uk_referrals_referee ON referrals (referee_user_id);
CREATE INDEX idx_referrals_referrer ON referrals (referrer_user_id, status);
CREATE INDEX idx_referrals_status   ON referrals (status, updated_at);

CREATE TRIGGER trg_referrals_updated_at AFTER UPDATE ON referrals
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE referrals SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id; END;
