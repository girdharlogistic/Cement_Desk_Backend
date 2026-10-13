-- Depot diary, third round (2026-10-14). What the dealer asked for after a
-- fortnight of real pages:
--
-- 1. Returns. Bags, rods, buckets and loads come *back* — a customer over-
--    ordered, a site closed. Until now the only place to write that was a
--    note on some other entry ("10mm ke 82 peice waps laae … sales return ka
--    isme nahi h isiliye yaha likha"), which neither moved stock nor printed.
--
--    Cement: a return is a godown adjustment of kind 'returned', carrying the
--    dealer, customer, vehicle and the gang that unloaded it, at a frozen
--    rate. It is an adjustment rather than a new kind of dispatch on purpose:
--    an app from before returns reads an unknown adjustment kind as a
--    'correction' and still *adds* the bags — stock on an un-updated phone
--    stays right. An unknown dispatch source would have been read as a godown
--    dispatch and taken them away.
--
--    Steel and material: a move of kind 'returned' (dealer, customer, lines),
--    stock goes up, the gang is paid the item's unloading rate. An older app
--    reads it as an 'adjust' — again, the stock still goes up.
--
-- 2. Sand and gitti, a fourth tab, sold by the cft. Two new item categories;
--    an older app files them under 'other' (its Chemical tab).
--
-- 3. A note for the day, per tab of the diary (and per company on the cement
--    tab, because a cement page goes to that company), printed at the top of
--    the PDF. One row per (firm, date, section, company); the app derives the
--    id from those, so two phones writing the same day's note meet on one row
--    and the second is told, like any other diary edit. A note is cleared by
--    saving it empty, never deleted — a tombstone under a derived id would
--    refuse the next note written for that day.
--
-- SQLite cannot change a CHECK constraint in place, so the three tables whose
-- lists grow are rebuilt: create, copy, drop, rename — inside this file's
-- transaction (db/migrate.ts), so a failure leaves the old tables untouched.
-- Nothing references these tables by foreign key, so the drop cascades into
-- nothing.

-- ---------------------------------------------------------- adjustments

CREATE TABLE depot_adjustments_new (
  firm_id     TEXT NOT NULL,
  id          TEXT NOT NULL,
  date        TEXT NOT NULL,
  company_id  TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('opening','damage','correction','returned')),
  grade_bags  TEXT NOT NULL DEFAULT '{}',
  note        TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  -- A return only: whose bags came back, and on what.
  party_id    TEXT,
  customer    TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  address     TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  vehicle_no  TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  -- The gang that unloaded a return into the godown, and ₹ per bag, frozen.
  labour_id   TEXT,
  labour_rate REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 1,
  updated_by  TEXT,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_depot_adjustments_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);
INSERT INTO depot_adjustments_new
  (firm_id, id, date, company_id, kind, grade_bags, note, created_at, updated_at, deleted_at, rev, updated_by)
SELECT firm_id, id, date, company_id, kind, grade_bags, note, created_at, updated_at, deleted_at, rev, updated_by
  FROM depot_adjustments;
DROP TABLE depot_adjustments;
ALTER TABLE depot_adjustments_new RENAME TO depot_adjustments;

CREATE INDEX idx_depot_adjustments_date  ON depot_adjustments (firm_id, date);
CREATE INDEX idx_depot_adjustments_sync  ON depot_adjustments (firm_id, updated_at);
CREATE INDEX idx_depot_adjustments_party ON depot_adjustments (firm_id, party_id, date);

CREATE TRIGGER trg_depot_adjustments_updated_at AFTER UPDATE ON depot_adjustments
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE depot_adjustments SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id AND id = NEW.id; END;

-- ---------------------------------------------------------- material items

CREATE TABLE material_items_new (
  firm_id     TEXT NOT NULL,
  id          TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'material' CHECK (kind IN ('steel','material')),
  name        TEXT NOT NULL COLLATE NOCASE,
  -- 'pcs' or 'kg' for steel; anything short for the rest ('kg', 'pcs',
  -- 'bag', 'ltr', 'cft', …) — it is a label the dealer reads, not maths.
  unit        TEXT NOT NULL DEFAULT 'pcs',
  category    TEXT NOT NULL DEFAULT 'other'
              CHECK (category IN ('steel','bindingWire','coverBlock','chemical','other','sand','gitti')),
  -- Steel only: [{"sizeMm":12,"rodsPerBundle":10,"kgPerRod":10.66}, …]
  sizes       TEXT NOT NULL DEFAULT '[]',
  -- ₹ per bundle for steel, ₹ per unit for the rest.
  load_rate   REAL NOT NULL DEFAULT 0,
  unload_rate REAL NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 1,
  updated_by  TEXT,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_material_items_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);
INSERT INTO material_items_new
  (firm_id, id, kind, name, unit, category, sizes, load_rate, unload_rate, sort_order,
   created_at, updated_at, deleted_at, rev, updated_by)
SELECT firm_id, id, kind, name, unit, category, sizes, load_rate, unload_rate, sort_order,
       created_at, updated_at, deleted_at, rev, updated_by
  FROM material_items;
DROP TABLE material_items;
ALTER TABLE material_items_new RENAME TO material_items;

CREATE INDEX idx_material_items_sync ON material_items (firm_id, updated_at);

CREATE TRIGGER trg_material_items_updated_at AFTER UPDATE ON material_items
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE material_items SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id AND id = NEW.id; END;

-- ---------------------------------------------------------- material moves

-- returned — came back from a dealer's customer (party_id required); stock
--            goes up and the gang is paid the item's unloading rate
CREATE TABLE material_moves_new (
  firm_id    TEXT NOT NULL,
  id         TEXT NOT NULL,
  date       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('receive','dispatch','opening','adjust','returned')),
  party_id   TEXT,
  customer   TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  supplier   TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  address    TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  vehicle_no TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  labour_id  TEXT,
  -- [{"itemId":"…","sizeMm":12,"qty":30,"bundles":3,"rate":4}, …]
  -- sizeMm is 0 for an item without sizes. bundles and rate are frozen.
  lines      TEXT NOT NULL DEFAULT '[]',
  note       TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at TEXT,
  rev        INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_material_moves_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);
INSERT INTO material_moves_new
  (firm_id, id, date, kind, party_id, customer, supplier, address, vehicle_no, labour_id, lines, note,
   created_at, updated_at, deleted_at, rev, updated_by)
SELECT firm_id, id, date, kind, party_id, customer, supplier, address, vehicle_no, labour_id, lines, note,
       created_at, updated_at, deleted_at, rev, updated_by
  FROM material_moves;
DROP TABLE material_moves;
ALTER TABLE material_moves_new RENAME TO material_moves;

CREATE INDEX idx_material_moves_date  ON material_moves (firm_id, date);
CREATE INDEX idx_material_moves_party ON material_moves (firm_id, party_id, date);
CREATE INDEX idx_material_moves_sync  ON material_moves (firm_id, updated_at);

CREATE TRIGGER trg_material_moves_updated_at AFTER UPDATE ON material_moves
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE material_moves SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id AND id = NEW.id; END;

-- ---------------------------------------------------------- day notes

CREATE TABLE depot_day_notes (
  firm_id    TEXT NOT NULL,
  id         TEXT NOT NULL,
  date       TEXT NOT NULL,
  section    TEXT NOT NULL CHECK (section IN ('cement','steel','chemical','sandGitti')),
  -- The cement tab is per company; null on the other tabs.
  company_id TEXT,
  text       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at TEXT,
  rev        INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_depot_day_notes_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);
CREATE INDEX idx_depot_day_notes_date ON depot_day_notes (firm_id, date);
CREATE INDEX idx_depot_day_notes_sync ON depot_day_notes (firm_id, updated_at);

CREATE TRIGGER trg_depot_day_notes_updated_at AFTER UPDATE ON depot_day_notes
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE depot_day_notes SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id AND id = NEW.id; END;
