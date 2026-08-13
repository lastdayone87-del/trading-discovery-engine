-- PR #211 made confirmed-country ENRICH_CHANNEL work independent of official
-- YouTube quota. Jobs deferred before that change still carry run_after at the
-- next UTC quota reset. Wake only those quota-specific legacy deferrals.
--
-- Do not touch YouTube.js/provider cooldowns, generic infrastructure retries,
-- unresolved-country enrichment, or any non-enrichment job.

UPDATE jobs AS j
SET run_after = now(),
    updated_at = now()
FROM channels AS c
WHERE j.type = 'ENRICH_CHANNEL'
  AND j.status = 'PENDING'
  AND j.run_after > now()
  AND j.payload->>'channelId' = c.channel_id
  AND c.country_status = 'CONFIRMED'
  AND j.last_error LIKE 'ENRICHMENT YouTube quota allocation is exhausted;%';
