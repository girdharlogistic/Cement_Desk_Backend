-- Paid plans, and who holds one.
--
-- RECONSTRUCTED. The original file was lost before it was ever committed; this
-- was rebuilt from the live schema and from the compiled module in dist/. It is
-- already recorded in `_migrations` on the production database, so it will
-- never run there again — it exists so that a fresh environment comes up with
-- the same shape production already has.

-- A plan is a name, a Play product, and a bag of features.
--
-- No price column, deliberately: Play owns money. The app takes `sku` to Play
-- Billing and asks what it costs, which is the only answer that is ever right —
-- the user's currency, their taxes, whatever promotion Play is running for
-- them. A price typed into a console could only ever be a second opinion that
-- disagrees with the charge.
CREATE TABLE plans (
  id          CHAR(36)     NOT NULL COLLATE utf8mb4_bin,
  name        VARCHAR(60)  NOT NULL COLLATE utf8mb4_0900_ai_ci,
  description VARCHAR(300) NOT NULL DEFAULT '' COLLATE utf8mb4_0900_ai_ci,
  sku         VARCHAR(120) NOT NULL DEFAULT '' COLLATE utf8mb4_bin,
  period      ENUM('month','year','lifetime') NOT NULL DEFAULT 'month',

  -- `Features` as JSON rather than columns: what a plan unlocks changes with
  -- the offer, and that should be a console edit, not a migration.
  features    JSON         NOT NULL,

  sort_order  INT          NOT NULL DEFAULT 0,

  -- Retiring a price sets this to 0. Plans are never deleted while anybody
  -- holds one — an orphaned entitlement silently becomes the free tier, which
  -- is somebody who paid quietly losing what they paid for.
  active      TINYINT(1)   NOT NULL DEFAULT 1,

  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id) CLUSTERED,
  KEY idx_plans_active (active, sort_order)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- One row per user, or none at all for the free tier.
--
-- `source` says where the entitlement came from: a Play subscription, an
-- operator grant, or a redeemed code. `purchase_token` is Play's, and is what
-- ties a payment to this account — a token already recorded against one user
-- must never entitle a second, which is the whole anti-sharing story.
CREATE TABLE entitlements (
  user_id        CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  plan_id        CHAR(36) NULL COLLATE utf8mb4_bin,
  source         ENUM('grant','play','code') NOT NULL DEFAULT 'grant',

  -- `grace` is Play's payment-retry window and still counts as entitled:
  -- cutting somebody off during it is how a failed card becomes a cancellation.
  status         ENUM('active','grace','expired','cancelled') NOT NULL DEFAULT 'active',

  -- NULL means no expiry — a lifetime plan, or an open-ended grant.
  expires_at     DATETIME(3) NULL,
  purchase_token VARCHAR(255) NOT NULL DEFAULT '' COLLATE utf8mb4_bin,
  note           VARCHAR(200) NOT NULL DEFAULT '' COLLATE utf8mb4_0900_ai_ci,

  -- What this account had before any of this existed. Kept apart from the plan
  -- because it is not part of the plan: it survives a lapse, a revoke and a
  -- change of plan, so nobody is ever dropped below what they already had.
  -- NULL where the account was inside the free tier anyway.
  grandfathered_firms   INT NULL,
  grandfathered_devices INT NULL,

  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id) CLUSTERED,
  KEY idx_ent_plan (plan_id),
  KEY idx_ent_token (purchase_token),
  CONSTRAINT fk_ent_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- Grandfathering, run once at the launch of paid plans.
--
-- Every account that already had more than one firm, or had signed in from more
-- than one device, keeps exactly that many. The free tier is one of each, and
-- taking something away from somebody who had been using it for months is not a
-- paywall, it is a bug they will report as one.
--
-- A no-op on a fresh database, which has no users to grandfather. It is kept
-- here as the record of what production was given.
INSERT INTO entitlements (user_id, plan_id, source, status, grandfathered_firms, grandfathered_devices, note)
SELECT
  u.id,
  NULL,
  'grant',
  'active',
  NULLIF((SELECT COUNT(*) FROM firm_members m JOIN firms f ON f.id = m.firm_id
           WHERE m.user_id = u.id AND f.deleted_at IS NULL), 1),
  NULLIF((SELECT COUNT(DISTINCT s.device_id) FROM sessions s
           WHERE s.user_id = u.id AND s.device_id IS NOT NULL), 1),
  'Grandfathered at launch of paid plans'
FROM users u
WHERE (SELECT COUNT(*) FROM firm_members m JOIN firms f ON f.id = m.firm_id
        WHERE m.user_id = u.id AND f.deleted_at IS NULL) > 1
   OR (SELECT COUNT(DISTINCT s.device_id) FROM sessions s
        WHERE s.user_id = u.id AND s.device_id IS NOT NULL) > 1;
