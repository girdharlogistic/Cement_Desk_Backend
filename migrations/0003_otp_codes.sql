-- Email verification and password reset move from a 32-byte opaque token to a
-- 6-digit numeric code the user types into the app.
--
-- A 6-digit code is only a million possibilities, so two things that did not
-- matter for a 256-bit token matter a great deal here:
--
--   1. SALT. An unsalted sha256 of a 6-digit number is not a hash at all — the
--      entire keyspace fits in a table you can build in seconds, so a leaked
--      auth_tokens row would hand over the live code. Each row now carries its
--      own 16-byte salt and stores sha256(salt || code).
--
--      The salt also keeps `uk_auth_token (token_hash)` workable. Two users
--      being issued the same code at the same time is a 1-in-a-million event
--      that WOULD have collided on that unique index and failed the insert.
--
--   2. ATTEMPTS. The lockout is the real defence, not the hash: a code is dead
--      after 5 wrong guesses, which caps an attacker at 5 tries per 10-minute
--      window rather than letting them walk the keyspace.
--
-- Both columns are nullable / defaulted, so the long opaque tokens still issued
-- for firm invites keep working unchanged: they store salt = NULL and are
-- looked up by hash exactly as before.

ALTER TABLE auth_tokens ADD COLUMN salt CHAR(32) NULL COLLATE utf8mb4_bin;

ALTER TABLE auth_tokens ADD COLUMN attempts SMALLINT NOT NULL DEFAULT 0;
