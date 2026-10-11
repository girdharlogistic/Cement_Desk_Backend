-- Depot diary, after a week of real use. Two things the dealer asked for:
--
-- 1. Dealer and customer, separately. This is a company depot: every bag
--    leaves against a *dealer's* order, and the vehicle at the gate belongs
--    to the dealer's customer. `party_id` was always the dealer in practice
--    (it is the Party master, shared with freight and Plus Minus, which are
--    kept per dealer). `customer` is the person or site the dealer sold to —
--    free text, suggested in the app from that dealer's history. A dealer
--    lifting for his own shop leaves it empty.
--
-- 2. Rates per gang. Two gangs at one depot are often paid differently. A
--    gang's own rate wins; NULL means "use the firm's standard rate" from
--    depot_settings, which is also what work with no gang named is paid at.
--    As before, every diary row freezes the rate it was saved under — these
--    columns only decide what a *new* row is priced at.

ALTER TABLE depot_dispatches ADD COLUMN customer TEXT NOT NULL DEFAULT '' COLLATE NOCASE;
ALTER TABLE material_moves   ADD COLUMN customer TEXT NOT NULL DEFAULT '' COLLATE NOCASE;

ALTER TABLE labours ADD COLUMN unload_rate REAL;
ALTER TABLE labours ADD COLUMN direct_rate REAL;
ALTER TABLE labours ADD COLUMN load_rate   REAL;
