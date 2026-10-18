-- Sariya tests (2026-10-19): the counter-side "per piece weight" check. A
-- piece is cut from each bar, measured and weighed; the app works out from
-- the IS 1786 nominal mass how much steel is missing, how thick the bar
-- really is and what load it carries. Up to four bars of one size per test.
--
-- The server stores what was measured and computes nothing, the same split
-- as the depot diary: `samples` is a JSON array of
--   {"brand":"Tata Tiscon","grade":"fe550d","lengthMm":300,"weightG":472,
--    "rate":6200,"rateUnit":"perQuintal"}
-- because a test is the unit of sync and nothing asks inside it.
--
-- Unlike the steel estimator (device-only) a test syncs: the dealer shows an
-- old one again, from another phone, after a reinstall.

CREATE TABLE steel_tests (
  firm_id     TEXT NOT NULL,
  id          TEXT NOT NULL,
  date        TEXT NOT NULL,
  size_mm     INTEGER NOT NULL,
  created_by  TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  created_for TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  note        TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  -- 'mm', 'cm' or 'inch': how the lengths were measured, so an edit shows
  -- the same numbers. Lengths are stored in mm whatever this says.
  length_unit TEXT NOT NULL DEFAULT 'mm',
  samples     TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  deleted_at  TEXT,
  rev         INTEGER NOT NULL DEFAULT 1,
  updated_by  TEXT,
  PRIMARY KEY (firm_id, id),
  CONSTRAINT fk_steel_tests_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);
CREATE INDEX idx_steel_tests_date ON steel_tests (firm_id, date);
CREATE INDEX idx_steel_tests_sync ON steel_tests (firm_id, updated_at);

CREATE TRIGGER trg_steel_tests_updated_at AFTER UPDATE ON steel_tests
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN UPDATE steel_tests SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now')
        WHERE firm_id = NEW.firm_id AND id = NEW.id; END;
