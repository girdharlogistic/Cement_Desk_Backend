-- Depot diary: the dealer's paper dispatch register, moved into the app.
--
-- What happens at the depot every day, and the table that records it:
--
--   a company truck arrives          → depot_trucks
--     some bags go straight onto a
--     customer's vehicle             → depot_dispatches (source 'truck')
--     the rest is unloaded           → depot_trucks.godown_bags
--   bags leave the godown            → depot_dispatches (source 'godown')
--   opening stock, burst bags,
--   a count that did not match       → depot_adjustments
--   who did the lifting              → labours, paid at depot_settings' rates
--
-- Godown stock is never stored. It is the sum of the rows above, per company
-- and grade, and the app computes it — the server keeps the facts, the same
-- division of labour as the stock ledger and the freight vouchers.
--
-- Grade quantities are JSON objects (`{"<gradeId>": bags}`) rather than child
-- tables. Nothing on the server ever asks a question *inside* one except "is
-- this grade still used?", which `json_each` answers (masters/service.ts), and
-- a row being the whole unit of sync means an edit can never land half its
-- lines. freight_entry_grades is a child table because it came from MySQL,
-- where that was the only option; it is not the pattern to copy.
--
-- No foreign keys to parties, companies, grades or labours, matching
-- freight_entries: deleting a master is refused while diary rows use it
-- (deleteWithCascade), which is the rule the dealer actually needs — a
-- register whose customers can vanish out from under it is not a register.

-- ---------------------------------------------------------------- labours

-- A loading gang, by the name the dealer calls it. A master like any other:
-- rides MASTER_DEFS for routes, push and pull.
CREATE TABLE labours (
  firm_id    TEXT NOT NULL,
  id         TEXT NOT NULL,
  name       TEXT NOT NULL COLLATE NOCASE,
  phone      TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at TEXT,
  rev        INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_labours_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);
CREATE INDEX idx_labours_sync ON labours (firm_id, updated_at);

CREATE TRIGGER trg_labours_updated_at AFTER UPDATE ON labours
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE labours SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id AND id = NEW.id; END;

-- ---------------------------------------------------------------- settings

-- One row per firm, keyed like opening_baselines. The three cement handling
-- rates, ₹ per bag. Every diary row freezes the rate it was saved under, so
-- changing these never re-prices a week already paid out.
CREATE TABLE depot_settings (
  firm_id     TEXT NOT NULL PRIMARY KEY,
  unload_rate REAL NOT NULL DEFAULT 0,
  direct_rate REAL NOT NULL DEFAULT 0,
  load_rate   REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 1,
  updated_by  TEXT,
  CONSTRAINT fk_depot_settings_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);
CREATE INDEX idx_depot_settings_sync ON depot_settings (firm_id, updated_at);

CREATE TRIGGER trg_depot_settings_updated_at AFTER UPDATE ON depot_settings
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE depot_settings SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id; END;

-- ---------------------------------------------------------------- trucks

-- received = direct + godown + short, per grade, when the truck is tallied.
-- `direct` is not a column: it is the depot_dispatches rows pointing back at
-- this truck, so a direct delivery is listed, exported and paid exactly like
-- any other dispatch. A truck that does not tally is still saved — the
-- dealer may not know where the last fifty bags went until evening — and the
-- app flags it until it does.
CREATE TABLE depot_trucks (
  firm_id       TEXT NOT NULL,
  id            TEXT NOT NULL,
  date          TEXT NOT NULL,
  company_id    TEXT NOT NULL,
  truck_no      TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  ref           TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  received_bags TEXT NOT NULL DEFAULT '{}',
  godown_bags   TEXT NOT NULL DEFAULT '{}',
  short_bags    TEXT NOT NULL DEFAULT '{}',
  labour_id     TEXT,
  unload_rate   REAL NOT NULL DEFAULT 0,
  note          TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at    TEXT,
  rev           INTEGER NOT NULL DEFAULT 1,
  updated_by    TEXT,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_depot_trucks_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);
CREATE INDEX idx_depot_trucks_date ON depot_trucks (firm_id, date);
CREATE INDEX idx_depot_trucks_sync ON depot_trucks (firm_id, updated_at);

CREATE TRIGGER trg_depot_trucks_updated_at AFTER UPDATE ON depot_trucks
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE depot_trucks SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id AND id = NEW.id; END;

-- ---------------------------------------------------------------- dispatches

-- Bags leaving the depot on a customer's vehicle (or 'SELF'). `source` says
-- where they came from, because the labour rate differs: off the truck
-- directly, or out of the godown. Only 'godown' rows reduce godown stock.
CREATE TABLE depot_dispatches (
  firm_id     TEXT NOT NULL,
  id          TEXT NOT NULL,
  date        TEXT NOT NULL,
  company_id  TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'godown' CHECK (source IN ('godown','truck')),
  truck_id    TEXT,
  party_id    TEXT NOT NULL,
  address     TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  vehicle_no  TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  grade_bags  TEXT NOT NULL DEFAULT '{}',
  labour_id   TEXT,
  labour_rate REAL NOT NULL DEFAULT 0,
  note        TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 1,
  updated_by  TEXT,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_depot_dispatches_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);
CREATE INDEX idx_depot_dispatches_date  ON depot_dispatches (firm_id, date);
CREATE INDEX idx_depot_dispatches_truck ON depot_dispatches (firm_id, truck_id);
CREATE INDEX idx_depot_dispatches_party ON depot_dispatches (firm_id, party_id, date);
CREATE INDEX idx_depot_dispatches_sync  ON depot_dispatches (firm_id, updated_at);

CREATE TRIGGER trg_depot_dispatches_updated_at AFTER UPDATE ON depot_dispatches
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE depot_dispatches SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id AND id = NEW.id; END;

-- ---------------------------------------------------------------- adjustments

-- Signed changes to godown stock that are not a truck or a dispatch. The one
-- 'opening' row per company is how a godown that already held stock on day
-- one gets its starting figure; 'damage' is burst and torn bags; 'correction'
-- squares the books with a physical count.
CREATE TABLE depot_adjustments (
  firm_id    TEXT NOT NULL,
  id         TEXT NOT NULL,
  date       TEXT NOT NULL,
  company_id TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('opening','damage','correction')),
  grade_bags TEXT NOT NULL DEFAULT '{}',
  note       TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at TEXT,
  rev        INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_depot_adjustments_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);
CREATE INDEX idx_depot_adjustments_date ON depot_adjustments (firm_id, date);
CREATE INDEX idx_depot_adjustments_sync ON depot_adjustments (firm_id, updated_at);

CREATE TRIGGER trg_depot_adjustments_updated_at AFTER UPDATE ON depot_adjustments
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE depot_adjustments SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id AND id = NEW.id; END;
