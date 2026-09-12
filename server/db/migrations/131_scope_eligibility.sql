-- Migration 131: catalog scope eligibility (non-destructive).
--
-- Adds channels.scope_eligibility WITHOUT touching country, country_status,
-- or confidence_score. Scope validity (market membership for catalog
-- filtering) is tracked separately from factual country attribution:
--   IN_SCOPE      attributed country is inside the supported universe
--                 (dormant supported countries included)
--   OUT_OF_SCOPE  attributed country is outside the supported universe
--   UNRESOLVED    no country attributed yet
--
-- Operational safety for the single-transaction runner (BEGIN/COMMIT around
-- the whole file: VALIDATE CONSTRAINT is illegal inside a transaction
-- block, so no NOT VALID + separate VALIDATE split is used):
--   * ADD COLUMN nullable with no DEFAULT (metadata-only, no rewrite).
--   * ONE backfill UPDATE (single sequential scan) with SQL-side
--     canonicalization matching resolveScopeEligibility(): BTRIM whitespace,
--     LOWER casefold, empty-after-trim -> UNRESOLVED. (Runtime additionally
--     applies Unicode NFKC; all 20 registry names are ASCII so the two are
--     equivalent here.)
--   * Plain ADD CHECK validated inline over already-backfilled rows. Table is
--     ~10k rows; the scan is milliseconds under a brief lock.
-- Application writes derive values via resolveScopeEligibility() in
-- server/scopeEligibility.ts. The supported list below MUST equal
-- SUPPORTED_PRODUCTION_COUNTRIES (lowercased); server/scopeRegistry.test.ts
-- fails on divergence.

ALTER TABLE channels ADD COLUMN IF NOT EXISTS scope_eligibility TEXT;

UPDATE channels SET scope_eligibility = CASE
  WHEN NULLIF(BTRIM(country), '') IS NULL THEN 'UNRESOLVED'
  WHEN LOWER(BTRIM(country)) IN (
    'united states','united kingdom','germany','france','spain','netherlands',
    'italy','australia','canada','japan','switzerland','denmark','sweden',
    'united arab emirates','singapore','new zealand','belgium','luxembourg',
    'ireland','norway'
  ) THEN 'IN_SCOPE'
  ELSE 'OUT_OF_SCOPE'
END
WHERE scope_eligibility IS NULL;

ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_scope_eligibility_check;
ALTER TABLE channels ADD CONSTRAINT channels_scope_eligibility_check
  CHECK (scope_eligibility IS NULL OR scope_eligibility IN ('IN_SCOPE','OUT_OF_SCOPE','UNRESOLVED'));
