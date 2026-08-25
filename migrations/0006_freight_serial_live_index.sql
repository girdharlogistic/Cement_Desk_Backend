-- The old UNIQUE KEY (firm_id, serial) applied to every row, tombstones
-- included, which meant a deleted entry's serial permanently blocked that
-- number from ever being reissued by compaction. A generated column that
-- collapses to NULL once deleted_at is set fixes this structurally: MySQL/TiDB
-- unique indexes never treat two NULLs as a collision, so a dead row's old
-- serial value stops mattering the moment it is tombstoned, no matter how many
-- times that number gets reused afterwards.
ALTER TABLE freight_entries
  ADD COLUMN serial_live BIGINT
    GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN serial ELSE NULL END) VIRTUAL;

ALTER TABLE freight_entries DROP INDEX uk_entry_serial;
ALTER TABLE freight_entries ADD UNIQUE KEY uk_entry_serial_live (firm_id, serial_live);
