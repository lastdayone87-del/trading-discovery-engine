-- Quarantine legacy extracted-vocabulary rows that can never be a valid search
-- atom. These are still useful as observation evidence, so they are downgraded
-- rather than deleted: trust tier 3 / validation 0 keeps them out of the
-- planner's legacy learned-vocabulary path while preserving audit history.
--
-- The letter test uses explicit Unicode ranges rather than [[:alpha:]] so it is
-- independent of the database LC_CTYPE and still recognises CJK/Cyrillic/
-- Arabic/Thai/Hangul letters. The prefix/numeric checks include fullwidth forms
-- because the writer stores the original spelling before NFKC normalization.
UPDATE extracted_trading_vocabulary
SET trust_tier = 3,
    validation_count = 0
WHERE trust_tier = 2
  AND (
    term !~ '[A-Za-zÀ-ÖØ-öø-ɏͰ-῿぀-㐀-鿿가-힣豈-﫿]'
    OR term ~ '^[#＃@＠]'
    OR term ~ '^[0-9０-９]+$'
  );
