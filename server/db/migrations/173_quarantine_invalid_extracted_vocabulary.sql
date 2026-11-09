-- Quarantine legacy extracted-vocabulary rows that can never be a valid search
-- atom. These are still useful as observation evidence, so they are downgraded
-- rather than deleted: trust tier 3 / validation 0 keeps them out of the
-- planner's legacy learned-vocabulary path while preserving audit history.
UPDATE extracted_trading_vocabulary
SET trust_tier = 3,
    validation_count = 0
WHERE trust_tier = 2
  AND (
    term !~ '[[:alpha:]]'
    OR term LIKE '#%'
    OR term LIKE '@%'
    OR term ~ '^[0-9]+$'
  );
