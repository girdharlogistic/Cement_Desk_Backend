-- A depot dispatch can be turned into a freight voucher with one tap in the
-- app; this remembers which one, so the diary shows "Freight №128" instead of
-- offering to add the same trip twice.
--
-- A plain column, no foreign key: freight entries are soft-deleted and the
-- app treats a link to a deleted (or not-yet-pulled) voucher as no link. The
-- freight entry is a money record with its own rules, and nothing here may
-- ever block deleting one.
ALTER TABLE depot_dispatches ADD COLUMN freight_entry_id TEXT;
