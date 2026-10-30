-- Steel estimator (2026-10-30): the brands a dealer quotes and the estimates
-- written against them. From app 1.5 to 1.15 this was the one module kept on
-- the device alone, so a rate list set up on the phone was missing from the
-- web app and gone after a sign-out. From here it syncs like everything else.
--
-- The server stores what the app sends and computes nothing, the same split
-- as the depot diary and the sariya tests.
--
-- steel_brands.sizes is a JSON array, one entry per bar size the brand stocks:
--   {"sizeMm":12,"lengthsPerBundle":10,"kgPerRod":10.4,"ratePerKg":62.5}
-- The rate is always stored per kg. `rate_unit` only says which unit the
-- dealer types it in, so a per-piece brand and a per-kg one compare directly.
-- `rate_updated_at` is an instant, not a business date: the picker shows how
-- old a rate list is, and a device adopting its old brands keeps the newer
-- of two lists with the same name.
--
-- steel_estimates.lines is a JSON array of
--   {"sizeMm":12,"pieces":40,"kg":416,"rate":650,"kgPerRod":10.4,"lengthsPerBundle":10}
-- frozen from the brand when the row was added. Revising a rate list must
-- never move an estimate the customer already has a picture of, which is
-- also why `brand_name` and `mode` are copied in. `brand_id` and the
-- `compare_brand_ids` are plain references, not foreign keys: an estimate
-- outlives the brand it was quoted from. `written_at` is when the estimate
-- was written, as an instant; the list is ordered by it.

CREATE TABLE steel_brands (
  firm_id         TEXT NOT NULL,
  id              TEXT NOT NULL,
  name            TEXT NOT NULL COLLATE NOCASE,
  -- 'perPiece' or 'perKg': how the brand is sold.
  mode            TEXT NOT NULL DEFAULT 'perPiece',
  -- 'perPiece' or 'perKg': how its rates are typed.
  rate_unit       TEXT NOT NULL DEFAULT 'perPiece',
  bar_length_m    REAL NOT NULL DEFAULT 12,
  sizes           TEXT NOT NULL DEFAULT '[]',
  rate_updated_at TEXT NOT NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at      TEXT,
  rev             INTEGER NOT NULL DEFAULT 1,
  updated_by      TEXT,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_steel_brands_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);
CREATE INDEX idx_steel_brands_sync ON steel_brands (firm_id, updated_at);

CREATE TRIGGER trg_steel_brands_updated_at AFTER UPDATE ON steel_brands
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE steel_brands SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id AND id = NEW.id; END;

CREATE TABLE steel_estimates (
  firm_id           TEXT NOT NULL,
  id                TEXT NOT NULL,
  brand_id          TEXT,
  brand_name        TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  mode              TEXT NOT NULL DEFAULT 'perPiece',
  customer          TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  written_at        TEXT NOT NULL,
  lines             TEXT NOT NULL DEFAULT '[]',
  binding_wire_kg   REAL NOT NULL DEFAULT 0,
  binding_wire_rate REAL NOT NULL DEFAULT 0,
  cover_block_qty   REAL NOT NULL DEFAULT 0,
  cover_block_rate  REAL NOT NULL DEFAULT 0,
  -- 'flat' or 'perTonne'.
  freight_mode      TEXT NOT NULL DEFAULT 'flat',
  freight_value     REAL NOT NULL DEFAULT 0,
  -- 'flat' or 'perBundle'.
  loading_mode      TEXT NOT NULL DEFAULT 'flat',
  loading_charges   REAL NOT NULL DEFAULT 0,
  discount_pct      REAL NOT NULL DEFAULT 0,
  -- 'steelOnly', 'steelAndMaterials' or 'total'.
  discount_scope    TEXT NOT NULL DEFAULT 'steelOnly',
  gst_pct           REAL NOT NULL DEFAULT 0,
  -- The brand comparison (app 1.15): which brands, in the order chosen, what
  -- is held fixed ('pieces' or 'kg'), and each compared brand's own discount
  -- as {brandId: percent}.
  compare_brand_ids TEXT NOT NULL DEFAULT '[]',
  compare_basis     TEXT NOT NULL DEFAULT 'pieces',
  compare_discounts TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at        TEXT,
  rev               INTEGER NOT NULL DEFAULT 1,
  updated_by        TEXT,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_steel_estimates_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);
CREATE INDEX idx_steel_estimates_sync ON steel_estimates (firm_id, updated_at);

CREATE TRIGGER trg_steel_estimates_updated_at AFTER UPDATE ON steel_estimates
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE steel_estimates SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id AND id = NEW.id; END;
