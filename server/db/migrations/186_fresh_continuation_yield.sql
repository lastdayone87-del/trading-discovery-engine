-- Migration 186: separate fresh continuation yield from health counters.
--
-- The existing marginal_confirmed_creators/marginal_quality_creators columns
-- intentionally count known creators and are consumed by country discovery
-- health. Continuation must reward only creators first seen as fresh, so the
-- fresh counts live in nullable columns. Legacy rows stay NULL and resume
-- ranking falls back to the existing counters.

ALTER TABLE autonomous_query_page_observations
  ADD COLUMN IF NOT EXISTS marginal_fresh_confirmed_creators INTEGER,
  ADD COLUMN IF NOT EXISTS marginal_fresh_quality_creators INTEGER;
