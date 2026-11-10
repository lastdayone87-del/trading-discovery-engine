-- Deferred intake review and human-evaluation ledger.
--
-- INTAKE_DEFERRED is a machine-owned holding state: the authoritative review
-- policy requires a plausible trading hypothesis, so these rows deliberately
-- do not create channel_reviews/NEEDS_REVIEW debt. This table gives them a
-- dedicated human interface and preserves the evidence used at deferral.

CREATE TABLE IF NOT EXISTS intake_deferred_reviews (
  channel_id TEXT PRIMARY KEY REFERENCES channels(channel_id) ON DELETE CASCADE,
  review_version INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING','DECIDED','SUPERSEDED')),
  decision TEXT
    CHECK (decision IS NULL OR decision IN ('TRADING','NON_TRADING','AMBIGUOUS')),
  reviewer TEXT,
  reason TEXT,
  notes TEXT,
  corrections JSONB NOT NULL DEFAULT '{}'::jsonb,
  system_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  language TEXT,
  country TEXT,
  metadata_quality TEXT,
  recheck_attempts INTEGER NOT NULL DEFAULT 0,
  last_checked_at TIMESTAMPTZ,
  next_recheck_at TIMESTAMPTZ,
  last_evidence_hash TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_intake_deferred_reviews_due
  ON intake_deferred_reviews(state, next_recheck_at)
  WHERE state IN ('PENDING','DECIDED');
CREATE INDEX IF NOT EXISTS idx_intake_deferred_reviews_country
  ON intake_deferred_reviews(country);
CREATE INDEX IF NOT EXISTS idx_intake_deferred_reviews_language
  ON intake_deferred_reviews(language);

CREATE TABLE IF NOT EXISTS intake_deferred_review_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_key TEXT NOT NULL UNIQUE,
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('TRADING','NON_TRADING','AMBIGUOUS')),
  reviewer TEXT NOT NULL,
  reason TEXT,
  notes TEXT,
  corrections JSONB NOT NULL DEFAULT '{}'::jsonb,
  system_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  review_version INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_intake_deferred_review_decisions_channel
  ON intake_deferred_review_decisions(channel_id, decided_at DESC);

-- Human decisions are append-only. Corrections create a new version; the
-- prior decision rows remain available to the review history.
CREATE OR REPLACE FUNCTION prevent_intake_deferred_decision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'intake_deferred_review_decisions is immutable';
END $$;
DROP TRIGGER IF EXISTS intake_deferred_review_decisions_immutable ON intake_deferred_review_decisions;
CREATE TRIGGER intake_deferred_review_decisions_immutable
  BEFORE UPDATE OR DELETE ON intake_deferred_review_decisions
  FOR EACH ROW EXECUTE FUNCTION prevent_intake_deferred_decision_mutation();

-- Human-verified evaluation samples. The system prediction is recorded for
-- comparison only; human_label is the independent ground truth and may be
-- AMBIGUOUS when the available evidence is insufficient.
CREATE TABLE IF NOT EXISTS human_evaluation_samples (
  sample_key TEXT PRIMARY KEY,
  channel_id TEXT,
  stratum TEXT NOT NULL,
  system_status TEXT,
  system_prediction TEXT
    CHECK (system_prediction IS NULL OR system_prediction IN ('TRADING','NON_TRADING','ABSTAIN')),
  human_label TEXT NOT NULL
    CHECK (human_label IN ('TRADING','NON_TRADING','AMBIGUOUS')),
  human_confidence TEXT NOT NULL DEFAULT 'MEDIUM'
    CHECK (human_confidence IN ('HIGH','MEDIUM','LOW')),
  language TEXT,
  country TEXT,
  metadata_quality TEXT,
  evidence_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  reviewer TEXT NOT NULL,
  notes TEXT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_human_evaluation_samples_label
  ON human_evaluation_samples(human_label);
CREATE INDEX IF NOT EXISTS idx_human_evaluation_samples_language
  ON human_evaluation_samples(language, human_label);
CREATE INDEX IF NOT EXISTS idx_human_evaluation_samples_country
  ON human_evaluation_samples(country, human_label);

-- Backfill review rows for any channel already held in INTAKE_DEFERRED before
-- this migration. #611 introduced the state, so production should normally
-- have no such rows; this keeps the interface complete if it does.
INSERT INTO intake_deferred_reviews(
  channel_id,review_version,state,system_snapshot,evidence_snapshot,language,country,
  metadata_quality,recheck_attempts,last_checked_at,next_recheck_at
)
SELECT
  c.channel_id,
  1,
  'PENDING',
  jsonb_build_object('backfilled',true,'reasonCodes','[]'::jsonb),
  jsonb_build_object(
    'targetCountry',COALESCE(j.payload->>'targetCountry','GLOBAL'),
    'source',COALESCE(j.payload->>'source','automated_query'),
    'candidate',COALESCE(j.payload->'candidate','{}'::jsonb)
  ),
  NULL,
  c.country,
  CASE
    WHEN COALESCE(length(j.payload->'candidate'->>'description'),0) >= 80 THEN 'RICH'
    WHEN GREATEST(
      COALESCE(jsonb_array_length(
        CASE WHEN jsonb_typeof(j.payload->'candidate'->'videoTitles')='array'
             THEN j.payload->'candidate'->'videoTitles' ELSE '[]'::jsonb END),0),
      COALESCE(jsonb_array_length(
        CASE WHEN jsonb_typeof(j.payload->'candidate'->'videoDescriptions')='array'
             THEN j.payload->'candidate'->'videoDescriptions' ELSE '[]'::jsonb END),0)
    ) > 0 THEN 'LIMITED'
    ELSE 'SPARSE'
  END,
  0,
  c.last_checked,
  now()
FROM channels c
LEFT JOIN LATERAL (
  SELECT payload FROM jobs
  WHERE type='ENRICH_CHANNEL' AND payload->>'channelId'=c.channel_id
  ORDER BY created_at DESC
  LIMIT 1
) j ON true
WHERE c.scan_status='INTAKE_DEFERRED'
ON CONFLICT(channel_id) DO NOTHING;
