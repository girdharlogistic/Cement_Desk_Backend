-- Scope child foreign keys to (firm_id, parent_id) and drop the global unique
-- indexes on `id`.
--
-- WHY: 0001 added UNIQUE KEY ux_<table>_id (id) to every master/document table
-- purely so single-column FKs like `REFERENCES parties(id)` would be legal —
-- MySQL/TiDB require the referenced column to be the leftmost column of a unique
-- index. The side effect is that a record id became unique across the WHOLE
-- deployment rather than within its firm, which the spec never asks for (§6.4
-- keys on PRIMARY KEY (firm_id, id) only). Two consequences, both real:
--
--   1. Restoring a backup into a second firm — the documented migration path in
--      §8.7 — fails with ER_DUP_ENTRY because the file's ids already exist in the
--      source firm. Same for a sync push that replays a device's rows into a
--      newly created firm.
--   2. The single-column FK could not express "the parent must be in the same
--      firm", so a cross-tenant child row was structurally possible.
--
-- Referencing the clustered PRIMARY KEY (firm_id, id) fixes both: the tenant
-- boundary becomes part of the constraint, and the global unique index is no
-- longer needed by anything.

-- ---------------------------------------------------------------- supporting indexes
-- A composite FK needs an index whose leftmost columns are the child columns.
-- Most are already covered by a PK prefix; these are the ones that are not.
-- They also serve the §5.6 cascade cleanups, which filter on exactly these pairs.
ALTER TABLE opening_baseline_party ADD KEY idx_obp_firm_grade (firm_id, grade_id);
ALTER TABLE stock_receipts         ADD KEY idx_sr_firm_day (firm_id, stock_day_id);
ALTER TABLE stock_receipts         ADD KEY idx_sr_firm_grade (firm_id, grade_id);
ALTER TABLE stock_day_cells        ADD KEY idx_sdc_firm_party (firm_id, party_id);
ALTER TABLE stock_day_cells        ADD KEY idx_sdc_firm_grade (firm_id, grade_id);
ALTER TABLE purchase_payments      ADD KEY idx_pp_firm_purchase (firm_id, purchase_id);
ALTER TABLE scheme_premium_grades  ADD KEY idx_spg_firm_grade (firm_id, grade_id);
ALTER TABLE claim_credit_notes     ADD KEY idx_ccn_firm_claim (firm_id, claim_id);

-- ---------------------------------------------------------------- re-point the FKs
ALTER TABLE party_routes DROP FOREIGN KEY fk_routes_party;
ALTER TABLE party_routes ADD CONSTRAINT fk_routes_party FOREIGN KEY (firm_id, party_id) REFERENCES parties(firm_id, id) ON DELETE CASCADE;

ALTER TABLE freight_entry_grades DROP FOREIGN KEY fk_feg_entry;
ALTER TABLE freight_entry_grades ADD CONSTRAINT fk_feg_entry FOREIGN KEY (firm_id, entry_id) REFERENCES freight_entries(firm_id, id) ON DELETE CASCADE;

ALTER TABLE opening_baseline_stock DROP FOREIGN KEY fk_obs_grade;
ALTER TABLE opening_baseline_stock ADD CONSTRAINT fk_obs_grade FOREIGN KEY (firm_id, grade_id) REFERENCES grades(firm_id, id) ON DELETE CASCADE;

ALTER TABLE opening_baseline_party DROP FOREIGN KEY fk_obp_party;
ALTER TABLE opening_baseline_party ADD CONSTRAINT fk_obp_party FOREIGN KEY (firm_id, party_id) REFERENCES parties(firm_id, id) ON DELETE CASCADE;

ALTER TABLE opening_baseline_party DROP FOREIGN KEY fk_obp_grade;
ALTER TABLE opening_baseline_party ADD CONSTRAINT fk_obp_grade FOREIGN KEY (firm_id, grade_id) REFERENCES grades(firm_id, id) ON DELETE CASCADE;

ALTER TABLE stock_receipts DROP FOREIGN KEY fk_sr_day;
ALTER TABLE stock_receipts ADD CONSTRAINT fk_sr_day FOREIGN KEY (firm_id, stock_day_id) REFERENCES stock_days(firm_id, id) ON DELETE CASCADE;

ALTER TABLE stock_receipts DROP FOREIGN KEY fk_sr_grade;
ALTER TABLE stock_receipts ADD CONSTRAINT fk_sr_grade FOREIGN KEY (firm_id, grade_id) REFERENCES grades(firm_id, id) ON DELETE CASCADE;

ALTER TABLE stock_day_cells DROP FOREIGN KEY fk_sdc_day;
ALTER TABLE stock_day_cells ADD CONSTRAINT fk_sdc_day FOREIGN KEY (firm_id, stock_day_id) REFERENCES stock_days(firm_id, id) ON DELETE CASCADE;

ALTER TABLE stock_day_cells DROP FOREIGN KEY fk_sdc_party;
ALTER TABLE stock_day_cells ADD CONSTRAINT fk_sdc_party FOREIGN KEY (firm_id, party_id) REFERENCES parties(firm_id, id) ON DELETE CASCADE;

ALTER TABLE stock_day_cells DROP FOREIGN KEY fk_sdc_grade;
ALTER TABLE stock_day_cells ADD CONSTRAINT fk_sdc_grade FOREIGN KEY (firm_id, grade_id) REFERENCES grades(firm_id, id) ON DELETE CASCADE;

ALTER TABLE purchases DROP FOREIGN KEY fk_pur_company;
ALTER TABLE purchases ADD CONSTRAINT fk_pur_company FOREIGN KEY (firm_id, company_id) REFERENCES companies(firm_id, id) ON DELETE CASCADE;

ALTER TABLE purchase_payments DROP FOREIGN KEY fk_pp_purchase;
ALTER TABLE purchase_payments ADD CONSTRAINT fk_pp_purchase FOREIGN KEY (firm_id, purchase_id) REFERENCES purchases(firm_id, id) ON DELETE CASCADE;

ALTER TABLE schemes DROP FOREIGN KEY fk_sch_company;
ALTER TABLE schemes ADD CONSTRAINT fk_sch_company FOREIGN KEY (firm_id, company_id) REFERENCES companies(firm_id, id) ON DELETE CASCADE;

ALTER TABLE scheme_slabs DROP FOREIGN KEY fk_slab_scheme;
ALTER TABLE scheme_slabs ADD CONSTRAINT fk_slab_scheme FOREIGN KEY (firm_id, scheme_id) REFERENCES schemes(firm_id, id) ON DELETE CASCADE;

ALTER TABLE scheme_premium_grades DROP FOREIGN KEY fk_spg_scheme;
ALTER TABLE scheme_premium_grades ADD CONSTRAINT fk_spg_scheme FOREIGN KEY (firm_id, scheme_id) REFERENCES schemes(firm_id, id) ON DELETE CASCADE;

ALTER TABLE scheme_premium_grades DROP FOREIGN KEY fk_spg_grade;
ALTER TABLE scheme_premium_grades ADD CONSTRAINT fk_spg_grade FOREIGN KEY (firm_id, grade_id) REFERENCES grades(firm_id, id) ON DELETE CASCADE;

ALTER TABLE claim_credit_notes DROP FOREIGN KEY fk_ccn_claim;
ALTER TABLE claim_credit_notes ADD CONSTRAINT fk_ccn_claim FOREIGN KEY (firm_id, claim_id) REFERENCES claims(firm_id, id) ON DELETE CASCADE;

-- ---------------------------------------------------------------- drop the global unique ids
-- Nothing references these any more; the clustered PK (firm_id, id) is the only
-- uniqueness rule an id needs, and it is firm-scoped as the spec intends.
ALTER TABLE parties          DROP INDEX ux_parties_id;
ALTER TABLE locations        DROP INDEX ux_locations_id;
ALTER TABLE grades           DROP INDEX ux_grades_id;
ALTER TABLE freight_entries  DROP INDEX ux_fe_id;
ALTER TABLE stock_days       DROP INDEX ux_sd_id;
ALTER TABLE companies        DROP INDEX ux_companies_id;
ALTER TABLE sources          DROP INDEX ux_sources_id;
ALTER TABLE purchases        DROP INDEX ux_pur_id;
ALTER TABLE schemes          DROP INDEX ux_sch_id;
ALTER TABLE claims           DROP INDEX ux_cl_id;
