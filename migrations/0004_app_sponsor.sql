-- The sponsored slot at the top of the app's Home screen.
--
-- Banner ads stay with AdMob, but this one card is ours to sell: a single row
-- the console writes and every install reads, so a sponsor can be put up (or
-- taken down) without shipping a release through Play review.
--
-- One row, id = 1, always present. A settings table with no rows is a table
-- every reader has to have an opinion about, so the migration seeds it and
-- writes are UPSERTs — `enabled = 0` means "show the in-house Cement Desk card",
-- which is what the app falls back to anyway if this is unreachable.
--
-- Text columns are ai_ci like every other human-facing name in the schema. The
-- URL and colour are exact-match, so utf8mb4_bin.

CREATE TABLE app_sponsor (
  id         TINYINT      NOT NULL,
  -- 0 = fall back to the in-house card. A sponsor whose run has ended is
  -- switched off rather than blanked, so their copy is still here next time.
  enabled    TINYINT(1)   NOT NULL DEFAULT 0,
  -- The disclosure line above the card — 'Sponsored', 'Partner', 'Ad'.
  label      VARCHAR(40)  NOT NULL DEFAULT 'Sponsored' COLLATE utf8mb4_0900_ai_ci,
  brand      VARCHAR(60)  NOT NULL DEFAULT '' COLLATE utf8mb4_0900_ai_ci,
  by_line    VARCHAR(80)  NOT NULL DEFAULT '' COLLATE utf8mb4_0900_ai_ci,
  pitch      VARCHAR(300) NOT NULL DEFAULT '' COLLATE utf8mb4_0900_ai_ci,
  -- Button text. Empty hides the button, which is the right answer for a
  -- sponsor who has given us no address to send anyone to.
  cta        VARCHAR(30)  NOT NULL DEFAULT '' COLLATE utf8mb4_0900_ai_ci,
  link_url   VARCHAR(500) NOT NULL DEFAULT '' COLLATE utf8mb4_bin,
  image_url  VARCHAR(500) NOT NULL DEFAULT '' COLLATE utf8mb4_bin,
  -- '#RRGGBB', or empty for the app's own sage. A sponsor's accent, so an
  -- UltraTech card does not arrive wearing our colours.
  accent     CHAR(7)      NOT NULL DEFAULT '' COLLATE utf8mb4_bin,
  updated_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id) CLUSTERED
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

INSERT INTO app_sponsor (id, enabled) VALUES (1, 0);
