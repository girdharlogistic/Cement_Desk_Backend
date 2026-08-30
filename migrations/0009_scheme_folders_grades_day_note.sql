-- Three additions that came in together, from one round of field feedback.
--
--   1. `stock_days.note` — a free-text remark for the whole day, so the dealer
--      can write down why a sheet looks the way it does ("SAP down tha",
--      "2 truck raste mein") next to the numbers rather than in a diary.
--
--   2. `scheme_folders` + `schemes.folder_id` — a dozen company letters arrive
--      every month and the flat scheme list stopped being readable. One level
--      only: a folder never holds another folder, so filing is a single choice
--      and there is no tree to walk. Deleting a folder frees its schemes; it
--      does not delete them.
--
--   3. `scheme_grades` — a scheme's grade scope as a set instead of one
--      nullable column. A letter routinely names two or three grades out of
--      the five we trade; `schemes.grade_id` could only say "one" or (NULL)
--      "all", so the middle case had to be entered as several near-identical
--      schemes that then double-counted in the pooled total.
--
-- `schemes.grade_id` is deliberately KEPT and still written. It is now a
-- derived convenience — the single grade when a scheme names exactly one, NULL
-- otherwise — and it is what an app build that predates this migration reads.
-- Dropping it would have made every older install widen a single-grade scheme
-- to all grades on its next pull. It is also what the grade-delete guard in
-- masters/service.ts checks, alongside the new table.
--
-- ---------------------------------------------------------------------------
-- WHY EVERY STATEMENT HERE IS RE-RUNNABLE
--
-- TiDB DDL auto-commits. A file that fails halfway leaves every statement
-- before the failure applied, while the file itself stays unrecorded in
-- `_migrations` and runs again from the top next time. Migrations run at boot,
-- so a half-applied file is not a bad deploy — it is a server that will not
-- start, and stays that way until the file can get past its own leftovers.
--
-- This one earned that comment. Its first draft wrote a single-column
-- `fk_sch_folder (folder_id) REFERENCES scheme_folders(id)`, which is the
-- pre-0002 style; 0002 re-pointed every foreign key in the schema to composite
-- `(firm_id, id)` and dropped the global unique indexes that single-column FKs
-- needed. The constraint was created and then could not be resolved by TiDB at
-- all, which made every subsequent DDL statement touching `scheme_folders`
-- fail — including the ones that would have repaired it. TiDB has no
-- `DROP FOREIGN KEY IF EXISTS`, and refuses `DROP COLUMN` while a foreign key
-- names the column, so it took a hand-run `SET foreign_key_checks = 0` against
-- the one affected database to clear it. That database is now identical to a
-- fresh one, and this file is the corrected version that runs on both.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------- day remark
ALTER TABLE stock_days
  ADD COLUMN IF NOT EXISTS note VARCHAR(500) NOT NULL DEFAULT '' COLLATE utf8mb4_0900_ai_ci AFTER date;

-- ---------------------------------------------------------------- folders
-- No UNIQUE KEY on `id` alone. 0002 removed exactly that from every other
-- table: a globally unique id breaks restoring a backup into a second firm,
-- which is the documented migration path in §8.7. The clustered
-- PRIMARY KEY (firm_id, id) is the only uniqueness an id needs.
CREATE TABLE IF NOT EXISTS scheme_folders (
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
  KEY idx_schfold_sync (firm_id, updated_at),
  CONSTRAINT fk_schfold_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- `folder_id` carries NO foreign key, on purpose — the same call `claims`
-- makes about `scheme_id` in 0001, for a related reason.
--
-- The constraint that would match the rest of the schema is
-- `(firm_id, folder_id) REFERENCES scheme_folders(firm_id, id) ON DELETE SET
-- NULL`. It cannot exist: SET NULL on a composite key nulls *every* column in
-- it, and `firm_id` is NOT NULL. The single-column alternative is the one that
-- broke this migration the first time round, and it would need back the
-- global-unique index that 0002 spent a whole migration removing.
--
-- So the rule lives in the service layer, in the places that write the column:
-- `checkFolder` rejects an unknown folder on the REST path, the sync push
-- files the scheme as unfiled rather than rejecting it (a folder deleted on
-- another device must not cost you the scheme), and `deleteWithCascade` nulls
-- the column itself when a folder is deleted. Both readers already render a
-- folder id that resolves to nothing as "unfiled", which is what makes a
-- dangling id harmless rather than a broken row.
ALTER TABLE schemes
  ADD COLUMN IF NOT EXISTS folder_id CHAR(36) NULL COLLATE utf8mb4_bin AFTER company_id;

-- Serves the `SET folder_id = NULL WHERE folder_id = ?` sweep that unfiles a
-- deleted folder's schemes.
ALTER TABLE schemes
  ADD INDEX IF NOT EXISTS idx_sch_folder (firm_id, folder_id);

-- ---------------------------------------------------------------- grade scope
-- Same shape as scheme_premium_grades after 0002 re-pointed it: a membership
-- set with no rev of its own, rewritten wholesale whenever the parent scheme
-- is written, with both foreign keys scoped to (firm_id, …) so a row cannot
-- reference another tenant's scheme or grade.
--
-- An EMPTY set means "all grades" — the absence of a filter, never "no
-- grades". Every reader has to spell that out.
CREATE TABLE IF NOT EXISTS scheme_grades (
  firm_id   CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  scheme_id CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  grade_id  CHAR(36) NOT NULL COLLATE utf8mb4_bin,
  PRIMARY KEY (firm_id, scheme_id, grade_id) CLUSTERED,
  -- The composite FK on (firm_id, grade_id) needs an index of its own; the PK
  -- prefix already covers (firm_id, scheme_id).
  KEY idx_schg_firm_grade (firm_id, grade_id),
  CONSTRAINT fk_schg_scheme FOREIGN KEY (firm_id, scheme_id) REFERENCES schemes(firm_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_schg_grade  FOREIGN KEY (firm_id, grade_id)  REFERENCES grades(firm_id, id)  ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- Backfill: every existing single-grade scheme becomes a one-element set, so
-- the new table is authoritative from the first read. Schemes with a NULL
-- grade_id stay absent from it, which is exactly "all grades". IGNORE so a
-- re-run of this file adds nothing a second time.
INSERT IGNORE INTO scheme_grades (firm_id, scheme_id, grade_id)
  SELECT firm_id, id, grade_id FROM schemes WHERE grade_id IS NOT NULL;
