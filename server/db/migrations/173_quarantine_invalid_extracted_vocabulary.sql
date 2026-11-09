-- Quarantine legacy extracted-vocabulary rows that can never be a valid search
-- atom. These are still useful as observation evidence, so they are downgraded
-- rather than deleted: trust tier 3 / validation 0 keeps them out of the
-- planner's legacy learned-vocabulary path while preserving audit history.
--
-- NFKC normalization folds fullwidth hashes/handles and fullwidth Latin, and
-- the explicit Unicode letter ranges are independent of LC_CTYPE. Markers are
-- rejected anywhere in the surface, matching isNuisanceVocabularySurface.
WITH candidate AS (
  SELECT id, normalize(term, NFKC) AS term_norm
  FROM extracted_trading_vocabulary
  WHERE trust_tier = 2
)
UPDATE extracted_trading_vocabulary v
SET trust_tier = 3,
    validation_count = 0
FROM candidate c
WHERE v.id = c.id
  AND (
    NOT (
      c.term_norm ~ '[A-Za-zÀ-ÖØ-öø-ɏ]'
      OR c.term_norm ~ '[Ͱ-῿]'
      OR c.term_norm ~ '[぀-ヿ]'
      OR c.term_norm ~ '[㐀-鿿]'
      OR c.term_norm ~ '[가-힣]'
      OR c.term_norm ~ '[豈-﫿]'
    )
    OR c.term_norm ~ '[#@]'
    OR c.term_norm ~ '^[0-9]+$'
  );
