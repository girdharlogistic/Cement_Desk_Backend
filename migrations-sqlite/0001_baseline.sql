-- Cement Desk — SQLite baseline.
--
-- This one file is the whole schema. It is not a translation of the nine TiDB
-- migrations one by one; it is the *end state* those nine produced, taken from
-- `SHOW CREATE TABLE` on the live database on 2026-09-05 and rewritten in
-- SQLite. Anyone reading migrations/0001..0009 for history should read those;
-- this is what actually runs now.
--
-- Dialect notes, because every one of these was a decision:
--
--  * DATE and DATETIME(3) are TEXT. SQLite has no date type, and the whole
--    codebase already treats both as strings ('yyyy-MM-dd' and
--    'YYYY-MM-DD HH:mm:ss.SSS' UTC) end to end — see lib/dates.ts. Declaring
--    them TEXT keeps the string exactly as written; a NUMERIC affinity would
--    quietly try to coerce it.
--  * DECIMAL is REAL. SQLite has no fixed-point type. Money here is rupees to
--    two places and quantities to three, far inside a double's exact range,
--    and every comparison in this codebase already carries the spec's 0.01
--    tolerance (§5.5, lib/num.ts). `num()` accepts a JS number as readily as
--    the string mysql2 used to hand it, so nothing above the driver changes.
--  * ENUM becomes TEXT + CHECK. The check is the point: it is the only thing
--    left rejecting a value the old ENUM would have rejected.
--  * MySQL's utf8mb4_0900_ai_ci columns become COLLATE NOCASE, so
--    `WHERE name = ?` and `ORDER BY name` keep behaving the way the app's
--    screens expect. NOCASE folds ASCII only, where 0900_ai_ci also folds
--    accents — irrelevant for the names this schema actually holds.
--    Columns that were utf8mb4_bin (ids, hashes, tokens, URLs) get SQLite's
--    default BINARY collation, which is the same exact-match behaviour.
--  * `ON UPDATE CURRENT_TIMESTAMP(3)` has no SQLite equivalent, so each table
--    that had it gets a trigger at the bottom of this file. The trigger's
--    `WHEN NEW.updated_at IS OLD.updated_at` guard reproduces the MySQL rule
--    that an UPDATE which sets the column explicitly wins over the automatic
--    stamp — several places in sync/push.ts depend on that.
--  * FOREIGN KEYs are enforced (the connection sets `PRAGMA foreign_keys=ON`).
--    They are all composite `(firm_id, …)` since migration 0002, which SQLite
--    supports as long as the parent columns carry a UNIQUE index — every one
--    of them is a primary key here.

-- ---------------------------------------------------------------- identity

CREATE TABLE users (
  id             TEXT NOT NULL PRIMARY KEY,
  email          TEXT NOT NULL COLLATE NOCASE,
  email_norm     TEXT NOT NULL,
  phone          TEXT,
  password_hash  TEXT NOT NULL,
  display_name   TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','suspended','deleted')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE UNIQUE INDEX uk_users_email ON users (email_norm);
-- MySQL's UNIQUE KEY on a nullable column lets many rows be NULL; so does
-- SQLite's, so an account without a phone number is still fine.
CREATE UNIQUE INDEX uk_users_phone ON users (phone);

CREATE TABLE firms (
  id              TEXT NOT NULL PRIMARY KEY,
  owner_user_id   TEXT NOT NULL,
  name            TEXT NOT NULL COLLATE NOCASE,
  fy_start_month  INTEGER NOT NULL DEFAULT 4,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  -- Per-firm watermark for the fast path in sync/pull. NULL means "unknown,
  -- do not trust me" and sends pull down the full scan (migration 0007).
  data_updated_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at      TEXT,
  CONSTRAINT fk_firms_owner FOREIGN KEY (owner_user_id) REFERENCES users(id)
);
CREATE INDEX idx_firms_owner ON firms (owner_user_id);

CREATE TABLE firm_members (
  firm_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'member'
             CHECK (role IN ('owner','admin','member','viewer')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  PRIMARY KEY (firm_id, user_id),
  CONSTRAINT fk_fm_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE,
  CONSTRAINT fk_fm_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_fm_user ON firm_members (user_id);

CREATE TABLE firm_counters (
  firm_id        TEXT NOT NULL PRIMARY KEY,
  freight_serial INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT fk_fc_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);

CREATE TABLE sessions (
  id                 TEXT NOT NULL PRIMARY KEY,
  user_id            TEXT NOT NULL,
  refresh_token_hash TEXT NOT NULL,
  device_id          TEXT,
  device_label       TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  user_agent         TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  ip                 BLOB,
  expires_at         TEXT NOT NULL,
  revoked_at         TEXT,
  replaced_by        TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  last_used_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uk_sessions_refresh ON sessions (refresh_token_hash);
CREATE INDEX idx_sessions_user ON sessions (user_id, expires_at);

CREATE TABLE auth_tokens (
  id         TEXT NOT NULL PRIMARY KEY,
  user_id    TEXT,
  email_norm TEXT,
  purpose    TEXT NOT NULL
             CHECK (purpose IN ('verify_email','reset_password','firm_invite')),
  token_hash TEXT NOT NULL,
  -- Was a JSON column. mysql2 parsed it on the way out; the two readers already
  -- handle a string (`typeof tok.payload === 'string' ? JSON.parse(...)`), which
  -- is what SQLite always returns, so nothing there changes.
  payload    TEXT,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  salt       TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX uk_auth_token ON auth_tokens (token_hash);
CREATE INDEX idx_auth_user ON auth_tokens (user_id, purpose);

-- ---------------------------------------------------------------- masters

CREATE TABLE parties (
  firm_id    TEXT NOT NULL,
  id         TEXT NOT NULL,
  code       TEXT COLLATE NOCASE,
  name       TEXT NOT NULL COLLATE NOCASE,
  phone      TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at TEXT,
  rev        INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_parties_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);
CREATE INDEX idx_parties_sync ON parties (firm_id, updated_at);

CREATE TABLE locations (
  firm_id    TEXT NOT NULL,
  id         TEXT NOT NULL,
  name       TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at TEXT,
  rev        INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_locations_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);
CREATE INDEX idx_locations_sync ON locations (firm_id, updated_at);

CREATE TABLE grades (
  firm_id       TEXT NOT NULL,
  id            TEXT NOT NULL,
  name          TEXT NOT NULL COLLATE NOCASE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  bag_weight_kg REAL NOT NULL DEFAULT 50.0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at    TEXT,
  rev           INTEGER NOT NULL DEFAULT 1,
  updated_by    TEXT,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_grades_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);
CREATE INDEX idx_grades_sync ON grades (firm_id, updated_at);

CREATE TABLE party_routes (
  firm_id         TEXT NOT NULL,
  id              TEXT NOT NULL,
  party_id        TEXT NOT NULL,
  location_id     TEXT NOT NULL,
  distance_km     REAL NOT NULL DEFAULT 0,
  revenue_per_bag REAL NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at      TEXT,
  rev             INTEGER NOT NULL DEFAULT 1,
  updated_by      TEXT,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_routes_firm  FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE,
  CONSTRAINT fk_routes_party FOREIGN KEY (firm_id, party_id) REFERENCES parties(firm_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uk_route ON party_routes (firm_id, party_id, location_id);
CREATE INDEX idx_routes_sync ON party_routes (firm_id, updated_at);
CREATE INDEX fk_routes_party ON party_routes (party_id);

-- ---------------------------------------------------------------- freight

CREATE TABLE freight_entries (
  firm_id          TEXT NOT NULL,
  id               TEXT NOT NULL,
  serial           INTEGER NOT NULL,
  date             TEXT NOT NULL,
  party_id         TEXT NOT NULL,
  location_id      TEXT NOT NULL,
  vehicle_no       TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  revenue_per_bag  REAL NOT NULL DEFAULT 0,
  bags             REAL NOT NULL DEFAULT 0,
  total_reimbursed REAL NOT NULL DEFAULT 0,
  basis            TEXT NOT NULL DEFAULT 'km' CHECK (basis IN ('km','bag')),
  cost_rate        REAL NOT NULL DEFAULT 0,
  cost_units       REAL NOT NULL DEFAULT 0,
  other_expenses   REAL NOT NULL DEFAULT 0,
  other_note       TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  total_cost       REAL NOT NULL DEFAULT 0,
  profit           REAL NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at       TEXT,
  rev              INTEGER NOT NULL DEFAULT 1,
  updated_by       TEXT,
  -- Collapses to NULL once the row is tombstoned, so a dead entry's serial
  -- stops blocking that number (migration 0006). SQLite unique indexes treat
  -- NULLs as distinct, exactly as MySQL's do, which is what makes this work.
  serial_live      INTEGER GENERATED ALWAYS AS
                   (CASE WHEN deleted_at IS NULL THEN serial ELSE NULL END) VIRTUAL,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_fe_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uk_entry_serial_live ON freight_entries (firm_id, serial_live);
CREATE INDEX idx_entries_date  ON freight_entries (firm_id, date);
CREATE INDEX idx_entries_party ON freight_entries (firm_id, party_id, date);
CREATE INDEX idx_entries_sync  ON freight_entries (firm_id, updated_at);

CREATE TABLE freight_entry_grades (
  firm_id  TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  grade_id TEXT NOT NULL,
  bags     REAL NOT NULL,
  PRIMARY KEY (firm_id, entry_id, grade_id),
  CONSTRAINT fk_feg_entry FOREIGN KEY (firm_id, entry_id) REFERENCES freight_entries(firm_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_feg_entry ON freight_entry_grades (entry_id);

-- ---------------------------------------------------------------- stock

CREATE TABLE opening_baselines (
  firm_id    TEXT NOT NULL PRIMARY KEY,
  date       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at TEXT,
  rev        INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  CONSTRAINT fk_ob_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);

CREATE TABLE opening_baseline_stock (
  firm_id  TEXT NOT NULL,
  grade_id TEXT NOT NULL,
  physical REAL NOT NULL DEFAULT 0,
  sap      REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (firm_id, grade_id),
  CONSTRAINT fk_obs_firm  FOREIGN KEY (firm_id) REFERENCES opening_baselines(firm_id) ON DELETE CASCADE,
  CONSTRAINT fk_obs_grade FOREIGN KEY (firm_id, grade_id) REFERENCES grades(firm_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_obs_grade ON opening_baseline_stock (grade_id);

CREATE TABLE opening_baseline_party (
  firm_id  TEXT NOT NULL,
  party_id TEXT NOT NULL,
  grade_id TEXT NOT NULL,
  x_qty    REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (firm_id, party_id, grade_id),
  CONSTRAINT fk_obp_firm  FOREIGN KEY (firm_id) REFERENCES opening_baselines(firm_id) ON DELETE CASCADE,
  CONSTRAINT fk_obp_party FOREIGN KEY (firm_id, party_id) REFERENCES parties(firm_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_obp_grade FOREIGN KEY (firm_id, grade_id) REFERENCES grades(firm_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_obp_party      ON opening_baseline_party (party_id);
CREATE INDEX idx_obp_firm_grade ON opening_baseline_party (firm_id, grade_id);

CREATE TABLE stock_days (
  firm_id    TEXT NOT NULL,
  id         TEXT NOT NULL,
  date       TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at TEXT,
  rev        INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_sd_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uk_stockday_date ON stock_days (firm_id, date);
CREATE INDEX idx_sd_sync ON stock_days (firm_id, updated_at);

CREATE TABLE stock_receipts (
  firm_id      TEXT NOT NULL,
  id           TEXT NOT NULL,
  stock_day_id TEXT NOT NULL,
  grade_id     TEXT NOT NULL,
  qty          REAL NOT NULL DEFAULT 0,
  sap_qty      REAL NOT NULL DEFAULT 0,
  ref          TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_sr_day   FOREIGN KEY (firm_id, stock_day_id) REFERENCES stock_days(firm_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_sr_grade FOREIGN KEY (firm_id, grade_id) REFERENCES grades(firm_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_sr_day        ON stock_receipts (stock_day_id);
CREATE INDEX idx_sr_firm_day   ON stock_receipts (firm_id, stock_day_id);
CREATE INDEX idx_sr_firm_grade ON stock_receipts (firm_id, grade_id);

CREATE TABLE stock_day_cells (
  firm_id      TEXT NOT NULL,
  stock_day_id TEXT NOT NULL,
  party_id     TEXT NOT NULL,
  grade_id     TEXT NOT NULL,
  billing      REAL NOT NULL DEFAULT 0,
  dispatch     REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (firm_id, stock_day_id, party_id, grade_id),
  CONSTRAINT fk_sdc_day   FOREIGN KEY (firm_id, stock_day_id) REFERENCES stock_days(firm_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_sdc_party FOREIGN KEY (firm_id, party_id) REFERENCES parties(firm_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_sdc_grade FOREIGN KEY (firm_id, grade_id) REFERENCES grades(firm_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_sdc_day        ON stock_day_cells (stock_day_id);
CREATE INDEX idx_sdc_firm_party ON stock_day_cells (firm_id, party_id);
CREATE INDEX idx_sdc_firm_grade ON stock_day_cells (firm_id, grade_id);

-- ---------------------------------------------------------------- landing

CREATE TABLE companies (
  firm_id    TEXT NOT NULL,
  id         TEXT NOT NULL,
  name       TEXT NOT NULL COLLATE NOCASE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at TEXT,
  rev        INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_co_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);
CREATE INDEX idx_companies_sync ON companies (firm_id, updated_at);

CREATE TABLE sources (
  firm_id    TEXT NOT NULL,
  id         TEXT NOT NULL,
  name       TEXT NOT NULL COLLATE NOCASE,
  type       TEXT NOT NULL DEFAULT 'plant' CHECK (type IN ('plant','depot')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at TEXT,
  rev        INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_so_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);
CREATE INDEX idx_sources_sync ON sources (firm_id, updated_at);

CREATE TABLE purchases (
  firm_id      TEXT NOT NULL,
  id           TEXT NOT NULL,
  date         TEXT NOT NULL,
  company_id   TEXT NOT NULL,
  grade_id     TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  qty          REAL NOT NULL,
  rate_per_bag REAL NOT NULL,
  invoice_no   TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at   TEXT,
  rev          INTEGER NOT NULL DEFAULT 1,
  updated_by   TEXT,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_pur_firm    FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE,
  CONSTRAINT fk_pur_company FOREIGN KEY (firm_id, company_id) REFERENCES companies(firm_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_pur_date    ON purchases (firm_id, date);
CREATE INDEX idx_pur_company ON purchases (firm_id, company_id, date);
CREATE INDEX idx_pur_sync    ON purchases (firm_id, updated_at);

CREATE TABLE purchase_payments (
  firm_id     TEXT NOT NULL,
  id          TEXT NOT NULL,
  purchase_id TEXT NOT NULL,
  date        TEXT NOT NULL,
  amount      REAL NOT NULL,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_pp_purchase FOREIGN KEY (firm_id, purchase_id) REFERENCES purchases(firm_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_pp_purchase      ON purchase_payments (purchase_id, date);
CREATE INDEX idx_pp_firm_purchase ON purchase_payments (firm_id, purchase_id);

CREATE TABLE scheme_folders (
  firm_id    TEXT NOT NULL,
  id         TEXT NOT NULL,
  name       TEXT NOT NULL COLLATE NOCASE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at TEXT,
  rev        INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_schfold_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);
CREATE INDEX idx_schfold_sync ON scheme_folders (firm_id, updated_at);

CREATE TABLE schemes (
  firm_id          TEXT NOT NULL,
  id               TEXT NOT NULL,
  name             TEXT NOT NULL COLLATE NOCASE,
  company_id       TEXT NOT NULL,
  -- Deliberately carries NO foreign key — see migration 0009. A folder id that
  -- resolves to nothing reads as "unfiled" everywhere, which is what makes a
  -- dangling value harmless.
  folder_id        TEXT,
  grade_id         TEXT,
  per_grade        INTEGER NOT NULL DEFAULT 0,
  source_id        TEXT,
  kind             TEXT NOT NULL DEFAULT 'fixed'
                   CHECK (kind IN ('fixed','variable','mix','cash')),
  period           TEXT CHECK (period IS NULL OR period IN ('monthly','quarterly','annual')),
  window_from      TEXT,
  window_to        TEXT,
  qty_unit         TEXT NOT NULL DEFAULT 'bag' CHECK (qty_unit IN ('bag','mt')),
  value_type       TEXT NOT NULL DEFAULT 'perBag'
                   CHECK (value_type IN ('perBag','perMt','percent')),
  min_premium_qty  REAL NOT NULL DEFAULT 0,
  min_premium_unit TEXT NOT NULL DEFAULT 'mt' CHECK (min_premium_unit IN ('bag','mt')),
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at       TEXT,
  rev              INTEGER NOT NULL DEFAULT 1,
  updated_by       TEXT,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_sch_firm    FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE,
  CONSTRAINT fk_sch_company FOREIGN KEY (firm_id, company_id) REFERENCES companies(firm_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_sch_company ON schemes (firm_id, company_id);
CREATE INDEX idx_sch_sync    ON schemes (firm_id, updated_at);
CREATE INDEX idx_sch_folder  ON schemes (firm_id, folder_id);

CREATE TABLE scheme_slabs (
  firm_id    TEXT NOT NULL,
  scheme_id  TEXT NOT NULL,
  slab_from  REAL NOT NULL,
  slab_value REAL NOT NULL,
  PRIMARY KEY (firm_id, scheme_id, slab_from),
  CONSTRAINT fk_slab_scheme FOREIGN KEY (firm_id, scheme_id) REFERENCES schemes(firm_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_slab_scheme ON scheme_slabs (scheme_id);

CREATE TABLE scheme_premium_grades (
  firm_id   TEXT NOT NULL,
  scheme_id TEXT NOT NULL,
  grade_id  TEXT NOT NULL,
  PRIMARY KEY (firm_id, scheme_id, grade_id),
  CONSTRAINT fk_spg_scheme FOREIGN KEY (firm_id, scheme_id) REFERENCES schemes(firm_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_spg_grade  FOREIGN KEY (firm_id, grade_id) REFERENCES grades(firm_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_spg_firm_grade ON scheme_premium_grades (firm_id, grade_id);

-- An EMPTY set means "all grades" — the absence of a filter, never "no
-- grades". Every reader has to spell that out (migration 0009).
CREATE TABLE scheme_grades (
  firm_id   TEXT NOT NULL,
  scheme_id TEXT NOT NULL,
  grade_id  TEXT NOT NULL,
  PRIMARY KEY (firm_id, scheme_id, grade_id),
  CONSTRAINT fk_schg_scheme FOREIGN KEY (firm_id, scheme_id) REFERENCES schemes(firm_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_schg_grade  FOREIGN KEY (firm_id, grade_id) REFERENCES grades(firm_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_schg_firm_grade ON scheme_grades (firm_id, grade_id);

-- claims.scheme_id is deliberately NOT a foreign key (§6.7): a claim must stay
-- readable even if its scheme row vanishes. company_id/scheme_name are
-- denormalized on purpose and are never nulled.
CREATE TABLE claims (
  firm_id     TEXT NOT NULL,
  id          TEXT NOT NULL,
  scheme_id   TEXT NOT NULL,
  company_id  TEXT NOT NULL,
  scheme_name TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  period_from TEXT NOT NULL,
  period_to   TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  bags        REAL NOT NULL DEFAULT 0,
  accrued     REAL NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'claimable'
              CHECK (status IN ('claimable','claimed','received')),
  sent_on     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 1,
  updated_by  TEXT,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_cl_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uk_claim_period ON claims (firm_id, scheme_id, period_from);
CREATE INDEX idx_claims_sync ON claims (firm_id, updated_at);

CREATE TABLE claim_credit_notes (
  firm_id  TEXT NOT NULL,
  id       TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  date     TEXT NOT NULL,
  number   TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  amount   REAL NOT NULL,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_ccn_claim FOREIGN KEY (firm_id, claim_id) REFERENCES claims(firm_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_ccn_claim      ON claim_credit_notes (claim_id, date);
CREATE INDEX idx_ccn_firm_claim ON claim_credit_notes (firm_id, claim_id);

-- ---------------------------------------------------------- sync bookkeeping

CREATE TABLE sync_state (
  user_id      TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  firm_id      TEXT NOT NULL,
  -- `cursor` is a keyword in some dialects; every query quotes it.
  "cursor"     TEXT NOT NULL,
  last_sync_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  PRIMARY KEY (user_id, device_id, firm_id)
);

CREATE TABLE idempotency_keys (
  key_hash      TEXT NOT NULL PRIMARY KEY,
  user_id       TEXT NOT NULL,
  endpoint      TEXT NOT NULL COLLATE NOCASE,
  response_code INTEGER NOT NULL,
  response_body TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX idx_idem_created ON idempotency_keys (created_at);

-- ---------------------------------------------------------- app-wide config

CREATE TABLE app_sponsor (
  id         INTEGER NOT NULL PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 0,
  label      TEXT NOT NULL DEFAULT 'Sponsored' COLLATE NOCASE,
  brand      TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  by_line    TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  pitch      TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  cta        TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  link_url   TEXT NOT NULL DEFAULT '',
  image_url  TEXT NOT NULL DEFAULT '',
  accent     TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
INSERT INTO app_sponsor (id, enabled) VALUES (1, 0);

CREATE TABLE plans (
  id          TEXT NOT NULL PRIMARY KEY,
  name        TEXT NOT NULL COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  sku         TEXT NOT NULL DEFAULT '',
  period      TEXT NOT NULL DEFAULT 'month'
              CHECK (period IN ('month','year','lifetime')),
  features    TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX idx_plans_active ON plans (active, sort_order);

CREATE TABLE entitlements (
  user_id               TEXT NOT NULL PRIMARY KEY,
  plan_id               TEXT,
  source                TEXT NOT NULL DEFAULT 'grant'
                        CHECK (source IN ('grant','play','code')),
  status                TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','grace','expired','cancelled')),
  expires_at            TEXT,
  purchase_token        TEXT NOT NULL DEFAULT '',
  note                  TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  grandfathered_firms   INTEGER,
  grandfathered_devices INTEGER,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  CONSTRAINT fk_ent_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_ent_plan  ON entitlements (plan_id);
CREATE INDEX idx_ent_token ON entitlements (purchase_token);

-- ------------------------------------------------- ON UPDATE CURRENT_TIMESTAMP
--
-- One trigger per table that carried `ON UPDATE CURRENT_TIMESTAMP(3)` in MySQL.
-- The WHEN guard is what makes it faithful: MySQL only auto-stamps when the
-- statement did not set the column itself, and sync/push.ts relies on being
-- able to write an explicit updated_at.

CREATE TRIGGER trg_users_updated_at AFTER UPDATE ON users
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE users SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id; END;

CREATE TRIGGER trg_firms_updated_at AFTER UPDATE ON firms
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE firms SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id; END;

CREATE TRIGGER trg_parties_updated_at AFTER UPDATE ON parties
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE parties SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id AND id = NEW.id; END;

CREATE TRIGGER trg_locations_updated_at AFTER UPDATE ON locations
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE locations SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id AND id = NEW.id; END;

CREATE TRIGGER trg_grades_updated_at AFTER UPDATE ON grades
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE grades SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id AND id = NEW.id; END;

CREATE TRIGGER trg_party_routes_updated_at AFTER UPDATE ON party_routes
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE party_routes SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id AND id = NEW.id; END;

CREATE TRIGGER trg_freight_entries_updated_at AFTER UPDATE ON freight_entries
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE freight_entries SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id AND id = NEW.id; END;

CREATE TRIGGER trg_opening_baselines_updated_at AFTER UPDATE ON opening_baselines
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE opening_baselines SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id; END;

CREATE TRIGGER trg_stock_days_updated_at AFTER UPDATE ON stock_days
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE stock_days SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id AND id = NEW.id; END;

CREATE TRIGGER trg_companies_updated_at AFTER UPDATE ON companies
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE companies SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id AND id = NEW.id; END;

CREATE TRIGGER trg_sources_updated_at AFTER UPDATE ON sources
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE sources SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id AND id = NEW.id; END;

CREATE TRIGGER trg_purchases_updated_at AFTER UPDATE ON purchases
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE purchases SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id AND id = NEW.id; END;

CREATE TRIGGER trg_scheme_folders_updated_at AFTER UPDATE ON scheme_folders
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE scheme_folders SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id AND id = NEW.id; END;

CREATE TRIGGER trg_schemes_updated_at AFTER UPDATE ON schemes
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE schemes SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id AND id = NEW.id; END;

CREATE TRIGGER trg_claims_updated_at AFTER UPDATE ON claims
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE claims SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id AND id = NEW.id; END;

CREATE TRIGGER trg_app_sponsor_updated_at AFTER UPDATE ON app_sponsor
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE app_sponsor SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id; END;

CREATE TRIGGER trg_plans_updated_at AFTER UPDATE ON plans
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE plans SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id; END;

CREATE TRIGGER trg_entitlements_updated_at AFTER UPDATE ON entitlements
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE entitlements SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE user_id = NEW.user_id; END;
