-- The sponsored card's link stopped being "a website" the first time a sponsor
-- wanted the button to ring their office. The address itself is still stored
-- whole in `link_url` — `tel:+919876543210`, `mailto:sales@…`, an https URL —
-- because that is what the phone's launcher takes; `link_kind` records which
-- of those it is, so the console can offer the right field and the app can
-- label a button that dials differently from one that opens a browser.
--
-- 'web' as the default is what every row written before today meant.
ALTER TABLE app_sponsor ADD COLUMN link_kind TEXT NOT NULL DEFAULT 'web'
  CHECK (link_kind IN ('web','phone','whatsapp','email'));
