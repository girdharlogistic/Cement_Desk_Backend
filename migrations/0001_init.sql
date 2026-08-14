-- Cement Desk — initial schema (spec §6), TiDB / MySQL 8.0 wire.
-- Conventions:
--  * utf8mb4_bin for ids/hashes (exact match), utf8mb4_0900_ai_ci for names.
--  * Tenant tables lead with firm_id and use clustered PKs (§6.1).
--  * Every tenant table carries sync columns (§6.3); child tables are owned by
--    their parent and deliberately do NOT carry independent sync columns.
--  * Business dates are DATE (TZ-opaque calendar days); audit stamps DATETIME(3) UTC.
--  * FKs require TiDB with foreign-key support enabled (GA in 7.x). The service
--    layer enforces every cascade of §5.6 regardless, since deletes are soft.

-- ---------------------------------------------------------------- identity
CREATE TABLE users (
  id             CHAR(36)      NOT NULL COLLATE utf8mb4_bin,
  email          VARCHAR(255)  NOT NULL COLLATE utf8mb4_0900_ai_ci,
  email_norm     VARCHAR(255)  NOT NULL COLLATE utf8mb4_bin,
  phone          VARCHAR(20)   NULL  COLLATE utf8mb4_bin,
  password_hash  VARCHAR(255)  NOT NULL COLLATE utf8mb4_bin,
  display_name   VARCHAR(120)  NOT NULL DEFAULT '' COLLATE utf8mb4_0900_ai_ci,
  email_verified TINYINT(1)    NOT NULL DEFAULT 0,
  status         ENUM('active','suspended','deleted') NOT NULL DEFAULT 'active',
  created_at     DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id) CLUSTERED,
  UNIQUE KEY uk_users_email (email_norm),
  UNIQUE KEY uk_users_phone (phone)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE firms (
  id              CHAR(36)     NOT NULL COLLATE utf8mb4_bin,
  owner_user_id   CHAR(36)     NOT NULL COLLATE utf8mb4_bin,
  name            VARCHAR(160) NOT NULL COLLATE utf8mb4_0900_ai_ci,
  fy_start_month  TINYINT      NOT NULL DEFAULT 4,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at      DATETIME(3)  NULL,
  PRIMARY KEY (id) CLUSTERED,
  KEY idx_firms_owner (owner_user_id),
  CONSTRAINT fk_firms_owner FOREIGN KEY (owner_user_id) REFERENCES users(id)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE firm_members (
  firm_id    CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  user_id    CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  role       ENUM('owner','admin','member','viewer') NOT NULL DEFAULT 'member',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (firm_id, user_id) CLUSTERED,
  KEY idx_fm_user (user_id),
  CONSTRAINT fk_fm_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE,
  CONSTRAINT fk_fm_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE firm_counters (
  firm_id        CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  freight_serial BIGINT   NOT NULL DEFAULT 0,
  PRIMARY KEY (firm_id) CLUSTERED,
  CONSTRAINT fk_fc_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE sessions (
  id                 CHAR(36)     NOT NULL COLLATE utf8mb4_bin,
  user_id            CHAR(36)     NOT NULL COLLATE utf8mb4_bin,
  refresh_token_hash CHAR(64)     NOT NULL COLLATE utf8mb4_bin,
  device_id          CHAR(36)     NULL COLLATE utf8mb4_bin,
  device_label       VARCHAR(120) NOT NULL DEFAULT '' COLLATE utf8mb4_0900_ai_ci,
  user_agent         VARCHAR(255) NOT NULL DEFAULT '' COLLATE utf8mb4_0900_ai_ci,
  ip                 VARBINARY(16) NULL,
  expires_at         DATETIME(3)  NOT NULL,
  revoked_at         DATETIME(3)  NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_used_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id) CLUSTERED,
  UNIQUE KEY uk_sessions_refresh (refresh_token_hash),
  KEY idx_sessions_user (user_id, expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE auth_tokens (
  id         CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  user_id    CHAR(36) NULL COLLATE utf8mb4_bin,
  email_norm VARCHAR(255) NULL COLLATE utf8mb4_bin,
  purpose    ENUM('verify_email','reset_password','firm_invite') NOT NULL,
  token_hash CHAR(64) NOT NULL COLLATE utf8mb4_bin,
  payload    JSON NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at    DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id) CLUSTERED,
  UNIQUE KEY uk_auth_token (token_hash),
  KEY idx_auth_user (user_id, purpose)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ---------------------------------------------------------------- masters
CREATE TABLE parties (
  firm_id    CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  id         CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  code       VARCHAR(40)  NULL COLLATE utf8mb4_0900_ai_ci,
  name       VARCHAR(160) NOT NULL COLLATE utf8mb4_0900_ai_ci,
  phone      VARCHAR(20)  NULL COLLATE utf8mb4_bin,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  rev        BIGINT NOT NULL DEFAULT 1,
  updated_by CHAR(36) NULL COLLATE utf8mb4_bin,
  PRIMARY KEY (firm_id, id) CLUSTERED,
  UNIQUE KEY ux_parties_id (id),
  KEY idx_parties_sync (firm_id, updated_at),
  CONSTRAINT fk_parties_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE locations (
  firm_id    CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  id         CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  name       VARCHAR(160) NOT NULL COLLATE utf8mb4_0900_ai_ci,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  rev        BIGINT NOT NULL DEFAULT 1,
  updated_by CHAR(36) NULL COLLATE utf8mb4_bin,
  PRIMARY KEY (firm_id, id) CLUSTERED,
  UNIQUE KEY ux_locations_id (id),
  KEY idx_locations_sync (firm_id, updated_at),
  CONSTRAINT fk_locations_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE grades (
  firm_id       CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  id            CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  name          VARCHAR(80) NOT NULL COLLATE utf8mb4_0900_ai_ci,
  sort_order    INT NOT NULL DEFAULT 0,
  bag_weight_kg DECIMAL(8,3) NOT NULL DEFAULT 50.000,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at    DATETIME(3) NULL,
  rev           BIGINT NOT NULL DEFAULT 1,
  updated_by    CHAR(36) NULL COLLATE utf8mb4_bin,
  PRIMARY KEY (firm_id, id) CLUSTERED,
  UNIQUE KEY ux_grades_id (id),
  KEY idx_grades_sync (firm_id, updated_at),
  CONSTRAINT fk_grades_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE party_routes (
  firm_id         CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  id              CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  party_id        CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  location_id     CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  distance_km     DECIMAL(10,3) NOT NULL DEFAULT 0,
  revenue_per_bag DECIMAL(12,4) NOT NULL DEFAULT 0,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at      DATETIME(3) NULL,
  rev             BIGINT NOT NULL DEFAULT 1,
  updated_by      CHAR(36) NULL COLLATE utf8mb4_bin,
  PRIMARY KEY (firm_id, id) CLUSTERED,
  UNIQUE KEY uk_route (firm_id, party_id, location_id),
  KEY idx_routes_sync (firm_id, updated_at),
  CONSTRAINT fk_routes_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE,
  CONSTRAINT fk_routes_party FOREIGN KEY (party_id) REFERENCES parties(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ---------------------------------------------------------------- freight
CREATE TABLE freight_entries (
  firm_id          CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  id               CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  serial           BIGINT   NOT NULL,
  date             DATE     NOT NULL,
  party_id         CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  location_id      CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  vehicle_no       VARCHAR(32)  NOT NULL DEFAULT '' COLLATE utf8mb4_0900_ai_ci,
  revenue_per_bag  DECIMAL(12,4) NOT NULL DEFAULT 0,
  bags             DECIMAL(14,3) NOT NULL DEFAULT 0,
  total_reimbursed DECIMAL(16,2) NOT NULL DEFAULT 0,
  basis            ENUM('km','bag') NOT NULL DEFAULT 'km',
  cost_rate        DECIMAL(12,4) NOT NULL DEFAULT 0,
  cost_units       DECIMAL(14,3) NOT NULL DEFAULT 0,
  other_expenses   DECIMAL(14,2) NOT NULL DEFAULT 0,
  other_note       VARCHAR(500)  NOT NULL DEFAULT '' COLLATE utf8mb4_0900_ai_ci,
  total_cost       DECIMAL(16,2) NOT NULL DEFAULT 0,
  profit           DECIMAL(16,2) NOT NULL DEFAULT 0,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at       DATETIME(3) NULL,
  rev              BIGINT NOT NULL DEFAULT 1,
  updated_by       CHAR(36) NULL COLLATE utf8mb4_bin,
  PRIMARY KEY (firm_id, id) CLUSTERED,
  UNIQUE KEY ux_fe_id (id),
  UNIQUE KEY uk_entry_serial (firm_id, serial),
  KEY idx_entries_date (firm_id, date),
  KEY idx_entries_party (firm_id, party_id, date),
  KEY idx_entries_sync (firm_id, updated_at),
  CONSTRAINT fk_fe_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE freight_entry_grades (
  firm_id  CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  entry_id CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  grade_id CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  bags     DECIMAL(14,3) NOT NULL,
  PRIMARY KEY (firm_id, entry_id, grade_id) CLUSTERED,
  CONSTRAINT fk_feg_entry FOREIGN KEY (entry_id) REFERENCES freight_entries(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ---------------------------------------------------------------- stock
CREATE TABLE opening_baselines (
  firm_id    CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  date       DATE     NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  rev        BIGINT NOT NULL DEFAULT 1,
  updated_by CHAR(36) NULL COLLATE utf8mb4_bin,
  PRIMARY KEY (firm_id) CLUSTERED,
  CONSTRAINT fk_ob_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE opening_baseline_stock (
  firm_id  CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  grade_id CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  physical DECIMAL(16,3) NOT NULL DEFAULT 0,
  sap      DECIMAL(16,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (firm_id, grade_id) CLUSTERED,
  CONSTRAINT fk_obs_firm  FOREIGN KEY (firm_id)  REFERENCES opening_baselines(firm_id) ON DELETE CASCADE,
  CONSTRAINT fk_obs_grade FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE opening_baseline_party (
  firm_id  CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  party_id CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  grade_id CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  x_qty    DECIMAL(16,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (firm_id, party_id, grade_id) CLUSTERED,
  CONSTRAINT fk_obp_firm  FOREIGN KEY (firm_id)  REFERENCES opening_baselines(firm_id) ON DELETE CASCADE,
  CONSTRAINT fk_obp_party FOREIGN KEY (party_id) REFERENCES parties(id) ON DELETE CASCADE,
  CONSTRAINT fk_obp_grade FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE stock_days (
  firm_id    CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  id         CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  date       DATE     NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  rev        BIGINT NOT NULL DEFAULT 1,
  updated_by CHAR(36) NULL COLLATE utf8mb4_bin,
  PRIMARY KEY (firm_id, id) CLUSTERED,
  UNIQUE KEY ux_sd_id (id),
  UNIQUE KEY uk_stockday_date (firm_id, date),
  KEY idx_sd_sync (firm_id, updated_at),
  CONSTRAINT fk_sd_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE stock_receipts (
  firm_id      CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  id           CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  stock_day_id CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  grade_id     CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  qty          DECIMAL(16,3) NOT NULL DEFAULT 0,
  sap_qty      DECIMAL(16,3) NOT NULL DEFAULT 0,
  ref          VARCHAR(120)  NOT NULL DEFAULT '' COLLATE utf8mb4_0900_ai_ci,
  PRIMARY KEY (firm_id, id) CLUSTERED,
  KEY idx_sr_day (stock_day_id),
  CONSTRAINT fk_sr_day   FOREIGN KEY (stock_day_id) REFERENCES stock_days(id) ON DELETE CASCADE,
  CONSTRAINT fk_sr_grade FOREIGN KEY (grade_id)     REFERENCES grades(id)     ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE stock_day_cells (
  firm_id      CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  stock_day_id CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  party_id     CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  grade_id     CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  billing      DECIMAL(16,3) NOT NULL DEFAULT 0,
  dispatch     DECIMAL(16,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (firm_id, stock_day_id, party_id, grade_id) CLUSTERED,
  CONSTRAINT fk_sdc_day   FOREIGN KEY (stock_day_id) REFERENCES stock_days(id) ON DELETE CASCADE,
  CONSTRAINT fk_sdc_party FOREIGN KEY (party_id)     REFERENCES parties(id)    ON DELETE CASCADE,
  CONSTRAINT fk_sdc_grade FOREIGN KEY (grade_id)     REFERENCES grades(id)     ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ---------------------------------------------------------------- landing
CREATE TABLE companies (
  firm_id    CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  id         CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  name       VARCHAR(160) NOT NULL COLLATE utf8mb4_0900_ai_ci,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  rev        BIGINT NOT NULL DEFAULT 1,
  updated_by CHAR(36) NULL COLLATE utf8mb4_bin,
  PRIMARY KEY (firm_id, id) CLUSTERED,
  UNIQUE KEY ux_companies_id (id),
  KEY idx_companies_sync (firm_id, updated_at),
  CONSTRAINT fk_co_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE sources (
  firm_id    CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  id         CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  name       VARCHAR(160) NOT NULL COLLATE utf8mb4_0900_ai_ci,
  type       ENUM('plant','depot') NOT NULL DEFAULT 'plant',
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  rev        BIGINT NOT NULL DEFAULT 1,
  updated_by CHAR(36) NULL COLLATE utf8mb4_bin,
  PRIMARY KEY (firm_id, id) CLUSTERED,
  UNIQUE KEY ux_sources_id (id),
  KEY idx_sources_sync (firm_id, updated_at),
  CONSTRAINT fk_so_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE purchases (
  firm_id      CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  id           CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  date         DATE     NOT NULL,
  company_id   CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  grade_id     CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  source_id    CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  qty          DECIMAL(16,3) NOT NULL,
  rate_per_bag DECIMAL(12,4) NOT NULL,
  invoice_no   VARCHAR(80) NOT NULL DEFAULT '' COLLATE utf8mb4_0900_ai_ci,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at   DATETIME(3) NULL,
  rev          BIGINT NOT NULL DEFAULT 1,
  updated_by   CHAR(36) NULL COLLATE utf8mb4_bin,
  PRIMARY KEY (firm_id, id) CLUSTERED,
  UNIQUE KEY ux_pur_id (id),
  KEY idx_pur_date (firm_id, date),
  KEY idx_pur_company (firm_id, company_id, date),
  KEY idx_pur_sync (firm_id, updated_at),
  CONSTRAINT fk_pur_firm    FOREIGN KEY (firm_id)    REFERENCES firms(id)     ON DELETE CASCADE,
  CONSTRAINT fk_pur_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE purchase_payments (
  firm_id     CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  id          CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  purchase_id CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  date        DATE     NOT NULL,
  amount      DECIMAL(16,2) NOT NULL,
  PRIMARY KEY (firm_id, id) CLUSTERED,
  KEY idx_pp_purchase (purchase_id, date),
  CONSTRAINT fk_pp_purchase FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE schemes (
  firm_id          CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  id               CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  name             VARCHAR(200) NOT NULL COLLATE utf8mb4_0900_ai_ci,
  company_id       CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  grade_id         CHAR(36) NULL COLLATE utf8mb4_bin,
  per_grade        TINYINT(1) NOT NULL DEFAULT 0,
  source_id        CHAR(36) NULL COLLATE utf8mb4_bin,
  kind             ENUM('fixed','variable','mix','cash') NOT NULL DEFAULT 'fixed',
  period           ENUM('monthly','quarterly','annual') NULL,
  window_from      DATE NULL,
  window_to        DATE NULL,
  qty_unit         ENUM('bag','mt') NOT NULL DEFAULT 'bag',
  value_type       ENUM('perBag','perMt','percent') NOT NULL DEFAULT 'perBag',
  min_premium_qty  DECIMAL(16,3) NOT NULL DEFAULT 0,
  min_premium_unit ENUM('bag','mt') NOT NULL DEFAULT 'mt',
  active           TINYINT(1) NOT NULL DEFAULT 1,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at       DATETIME(3) NULL,
  rev              BIGINT NOT NULL DEFAULT 1,
  updated_by       CHAR(36) NULL COLLATE utf8mb4_bin,
  PRIMARY KEY (firm_id, id) CLUSTERED,
  UNIQUE KEY ux_sch_id (id),
  KEY idx_sch_company (firm_id, company_id),
  KEY idx_sch_sync (firm_id, updated_at),
  CONSTRAINT fk_sch_firm    FOREIGN KEY (firm_id)    REFERENCES firms(id)     ON DELETE CASCADE,
  CONSTRAINT fk_sch_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE scheme_slabs (
  firm_id    CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  scheme_id  CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  slab_from  DECIMAL(16,4) NOT NULL,
  slab_value DECIMAL(16,4) NOT NULL,
  PRIMARY KEY (firm_id, scheme_id, slab_from) CLUSTERED,
  CONSTRAINT fk_slab_scheme FOREIGN KEY (scheme_id) REFERENCES schemes(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE scheme_premium_grades (
  firm_id   CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  scheme_id CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  grade_id  CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  PRIMARY KEY (firm_id, scheme_id, grade_id) CLUSTERED,
  CONSTRAINT fk_spg_scheme FOREIGN KEY (scheme_id) REFERENCES schemes(id) ON DELETE CASCADE,
  CONSTRAINT fk_spg_grade  FOREIGN KEY (grade_id)  REFERENCES grades(id)  ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- claims.scheme_id is deliberately NOT an FK (§6.7 note): a claim must remain
-- readable even if its scheme row vanishes. company_id/scheme_name are
-- denormalized on purpose and are never nulled. Scheme->claims delete is done
-- explicitly in the service layer (§5.6).
CREATE TABLE claims (
  firm_id     CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  id          CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  scheme_id   CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  company_id  CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  scheme_name VARCHAR(200) NOT NULL DEFAULT '' COLLATE utf8mb4_0900_ai_ci,
  period_from DATE NOT NULL,
  period_to   DATE NOT NULL,
  label       VARCHAR(60) NOT NULL DEFAULT '' COLLATE utf8mb4_0900_ai_ci,
  bags        DECIMAL(16,3) NOT NULL DEFAULT 0,
  accrued     DECIMAL(16,2) NOT NULL DEFAULT 0,
  status      ENUM('claimable','claimed','received') NOT NULL DEFAULT 'claimable',
  sent_on     DATE NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at  DATETIME(3) NULL,
  rev         BIGINT NOT NULL DEFAULT 1,
  updated_by  CHAR(36) NULL COLLATE utf8mb4_bin,
  PRIMARY KEY (firm_id, id) CLUSTERED,
  UNIQUE KEY ux_cl_id (id),
  UNIQUE KEY uk_claim_period (firm_id, scheme_id, period_from),
  KEY idx_claims_sync (firm_id, updated_at),
  CONSTRAINT fk_cl_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE claim_credit_notes (
  firm_id  CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  id       CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  claim_id CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  date     DATE NOT NULL,
  number   VARCHAR(80) NOT NULL DEFAULT '' COLLATE utf8mb4_0900_ai_ci,
  amount   DECIMAL(16,2) NOT NULL,
  PRIMARY KEY (firm_id, id) CLUSTERED,
  KEY idx_ccn_claim (claim_id, date),
  CONSTRAINT fk_ccn_claim FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ---------------------------------------------------------------- sync bookkeeping
CREATE TABLE sync_state (
  user_id      CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  device_id    CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  firm_id      CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  `cursor`     DATETIME(3) NOT NULL,
  last_sync_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, device_id, firm_id) CLUSTERED
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE idempotency_keys (
  key_hash       CHAR(64)     NOT NULL COLLATE utf8mb4_bin,
  user_id        CHAR(36)     NOT NULL COLLATE utf8mb4_bin,
  endpoint       VARCHAR(120) NOT NULL COLLATE utf8mb4_0900_ai_ci,
  response_code  SMALLINT     NOT NULL,
  response_body  JSON         NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (key_hash) CLUSTERED,
  KEY idx_idem_created (created_at)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
