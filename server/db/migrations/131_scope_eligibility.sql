-- Migration 131: catalog scope eligibility (non-destructive).
--
-- Adds channels.scope_eligibility WITHOUT touching country, country_status,
-- or confidence_score. Scope validity (market membership for catalog
-- filtering) is tracked separately from factual country attribution:
--   IN_SCOPE      attributed country is inside the supported universe
--                 (dormant supported countries included)
--   OUT_OF_SCOPE  attributed country is outside the supported universe
--   UNRESOLVED    no country attributed yet
-- The column is nullable with no DEFAULT (metadata-only ADD, no table
-- rewrite). Backfill runs as three small categorized UPDATEs. A CHECK
-- constraint guards the value domain; application writes derive values via
-- resolveScopeEligibility() in server/scopeEligibility.ts.

ALTER TABLE channels ADD COLUMN IF NOT EXISTS scope_eligibility TEXT;

-- Single-pass backfill (one sequential scan, no per-row locking beyond the
-- statement): supported universe (dormant included) -> IN_SCOPE, any other
-- attributed country -> OUT_OF_SCOPE, unattributed -> UNRESOLVED.
UPDATE channels SET scope_eligibility = CASE
  WHEN country IN (
    'United States','United Kingdom','Germany','France','Spain','Netherlands',
    'Italy','Australia','Canada','Japan','Switzerland','Denmark','Sweden',
    'United Arab Emirates','Singapore','New Zealand','Belgium','Luxembourg',
    'Ireland','Norway'
  ) THEN 'IN_SCOPE'
  WHEN country IS NOT NULL THEN 'OUT_OF_SCOPE'
  ELSE 'UNRESOLVED'
END
WHERE scope_eligibility IS NULL;

ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_scope_eligibility_check;
ALTER TABLE channels ADD CONSTRAINT channels_scope_eligibility_check
  CHECK (scope_eligibility IS NULL OR scope_eligibility IN ('IN_SCOPE','OUT_OF_SCOPE','UNRESOLVED')) NOT VALID;
ALTER TABLE channels VALIDATE CONSTRAINT channels_scope_eligibility_check;
