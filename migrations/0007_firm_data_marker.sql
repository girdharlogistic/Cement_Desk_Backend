-- A per-firm watermark: when did anything inside this firm last change?
--
-- `sync/pull` used to answer "has anything changed since your cursor?" by
-- scanning twelve tables. Each of those is a separate statement and TiDB bills
-- a request unit per statement, so an empty pull — which is over ninety per
-- cent of them — cost 6.3 RU to say "no". Reading one column costs 0.5.
--
-- Maintained by an onResponse hook in app.ts, which fires for every successful
-- mutating request on a `/firms/:firmId/*` route. That is the one place every
-- write to firm-scoped data already passes through, so no service has to
-- remember to bump it and a new route cannot forget to.
--
-- NULL means "unknown, do not trust me" and makes pull fall back to the full
-- scan. Existing rows are seeded with the current time rather than NULL: every
-- device's stored cursor is older than that, so the first pull after this
-- migration takes the slow path once and the fast path forever after.
-- DEFAULT, not just NULL: a firm created after this migration has to start
-- with a usable watermark or every pull for it would take the slow path until
-- its first write. NULL stays legal and still means "unknown / do not trust".
ALTER TABLE firms
  ADD COLUMN data_updated_at DATETIME(3) NULL DEFAULT CURRENT_TIMESTAMP(3) AFTER updated_at;

UPDATE firms SET data_updated_at = UTC_TIMESTAMP(3) WHERE data_updated_at IS NULL;
