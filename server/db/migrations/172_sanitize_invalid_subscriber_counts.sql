-- Subscriber counts must be parseable numbers/abbreviations. Legacy channel
-- rows stored handles (for example '@SomeTrader') in subscriber_count, which
-- the low-audience gate correctly treats as unknown and fail-opens. Persistence
-- now rejects those values; this one-time cleanup removes the poisoned values
-- already stored so they cannot be mistaken for audience evidence.
--
-- Safe to re-run: the predicate only matches values that do not parse as a
-- subscriber count and the write is idempotent once they are NULL.
UPDATE channels
SET subscriber_count = NULL
WHERE subscriber_count IS NOT NULL
  AND btrim(subscriber_count) <> ''
  AND btrim(subscriber_count) !~* '^[0-9]+([.][0-9]+)?[[:space:]]*(K|M)?([[:space:]]+SUBSCRIBERS?)?$';
