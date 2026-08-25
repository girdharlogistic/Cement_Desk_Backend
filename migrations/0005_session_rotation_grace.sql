ALTER TABLE sessions
  ADD COLUMN replaced_by CHAR(36) NULL COLLATE utf8mb4_bin AFTER revoked_at;
