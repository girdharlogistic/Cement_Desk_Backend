-- Depot diary, part two: steel and the other material a depot sells beside
-- cement — binding wire, cover blocks, waterproofing chemicals.
--
--   what is stocked          → material_items
--   anything in or out       → material_moves
--
-- A steel item is a *brand*, with a spec per bar size: rods in its bundle
-- and the weight of one rod. Brands differ in both, and the dealer's
-- loading gangs are paid per bundle at a rate that differs by brand, so the
-- spec lives on the brand and every move line freezes the bundles it
-- counted and the rate it paid. Stock is kept per brand and per size, in the
-- brand's own unit (pieces or kg).
--
-- Other items carry a category, a unit (kg, pcs, bags, litres, …) and, if
-- the dealer pays for handling them, a per-unit rate.
--
-- Lines are a JSON array on the move, for the same reason the cement diary
-- keeps grade quantities as JSON (0004's header): a move is the unit of
-- sync, and the only question the server asks inside one is "is this item
-- still used?".

CREATE TABLE material_items (
  firm_id     TEXT NOT NULL,
  id          TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'material' CHECK (kind IN ('steel','material')),
  name        TEXT NOT NULL COLLATE NOCASE,
  -- 'pcs' or 'kg' for steel; anything short for the rest ('kg', 'pcs',
  -- 'bag', 'ltr', 'box', …) — it is a label the dealer reads, not maths.
  unit        TEXT NOT NULL DEFAULT 'pcs',
  category    TEXT NOT NULL DEFAULT 'other'
              CHECK (category IN ('steel','bindingWire','coverBlock','chemical','other')),
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
CREATE INDEX idx_material_items_sync ON material_items (firm_id, updated_at);

CREATE TRIGGER trg_material_items_updated_at AFTER UPDATE ON material_items
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE material_items SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id AND id = NEW.id; END;

-- receive  — bought in; party_id is null, `supplier` says from whom
-- dispatch — sold out to a customer (party_id required)
-- opening  — what was on the floor when the register started
-- adjust   — a count correction, either sign
CREATE TABLE material_moves (
  firm_id    TEXT NOT NULL,
  id         TEXT NOT NULL,
  date       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('receive','dispatch','opening','adjust')),
  party_id   TEXT,
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
CREATE INDEX idx_material_moves_date  ON material_moves (firm_id, date);
CREATE INDEX idx_material_moves_party ON material_moves (firm_id, party_id, date);
CREATE INDEX idx_material_moves_sync  ON material_moves (firm_id, updated_at);

CREATE TRIGGER trg_material_moves_updated_at AFTER UPDATE ON material_moves
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE material_moves SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id AND id = NEW.id; END;
