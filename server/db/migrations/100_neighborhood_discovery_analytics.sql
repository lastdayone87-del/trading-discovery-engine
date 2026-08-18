-- Phase 2: Neighborhood Overlap & Saturation Observations
CREATE TABLE IF NOT EXISTS neighborhood_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  neighborhood_key TEXT NOT NULL REFERENCES discovery_neighborhoods(neighborhood_key) ON DELETE CASCADE,
  query_run_id UUID UNIQUE REFERENCES query_runs(id) ON DELETE CASCADE,
  total_results INTEGER NOT NULL DEFAULT 0,
  duplicate_ratio REAL NOT NULL DEFAULT 0,
  known_creator_ratio REAL NOT NULL DEFAULT 0,
  new_creator_ratio REAL NOT NULL DEFAULT 0,
  relevant_new_creator_ratio REAL NOT NULL DEFAULT 0,
  quality_new_creator_ratio REAL NOT NULL DEFAULT 0,
  jaccard_similarity REAL,
  result_set_overlap REAL,
  quota_consumed INTEGER NOT NULL DEFAULT 0,
  retrieval_depth INTEGER NOT NULL DEFAULT 1,
  search_ordering TEXT NOT NULL DEFAULT 'RELEVANCE',
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_neighborhood_obs_key ON neighborhood_observations(neighborhood_key);
CREATE INDEX IF NOT EXISTS idx_neighborhood_obs_run ON neighborhood_observations(query_run_id);
CREATE INDEX IF NOT EXISTS idx_neighborhood_obs_time ON neighborhood_observations(observed_at);
-- Supports the bounded, newest-first Phase-3 prediction history lookup.
CREATE INDEX IF NOT EXISTS idx_neighborhood_obs_key_time
  ON neighborhood_observations(neighborhood_key, observed_at DESC);

-- Phase 3: Marginal Discovery Value (Shadow Only)
CREATE TABLE IF NOT EXISTS neighborhood_marginal_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  neighborhood_key TEXT NOT NULL REFERENCES discovery_neighborhoods(neighborhood_key) ON DELETE CASCADE,
  query_run_id UUID UNIQUE REFERENCES query_runs(id) ON DELETE CASCADE,
  expected_marginal_value REAL NOT NULL DEFAULT 0,
  observed_marginal_value REAL NOT NULL DEFAULT 0,
  coverage_gain REAL NOT NULL DEFAULT 0,
  information_gain REAL NOT NULL DEFAULT 0,
  frontier_expansion_gain REAL NOT NULL DEFAULT 0,
  uncertainty_reduction REAL NOT NULL DEFAULT 0,
  quota_cost INTEGER NOT NULL DEFAULT 0,
  review_cost INTEGER NOT NULL DEFAULT 0,
  redundancy_penalty REAL NOT NULL DEFAULT 0,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_neighborhood_mv_key ON neighborhood_marginal_values(neighborhood_key);
CREATE INDEX IF NOT EXISTS idx_neighborhood_mv_run ON neighborhood_marginal_values(query_run_id);
CREATE INDEX IF NOT EXISTS idx_neighborhood_mv_time ON neighborhood_marginal_values(calculated_at);

-- Freeze the Phase-3 prediction at retrieval-action creation time. This trigger fires
-- after the authoritative query run has been scheduled and neighborhood lineage has
-- been persisted, but before the YouTube retrieval result exists. It therefore uses
-- only information available pre-run: the reserved query quota and the 20 most recent
-- completed neighborhood observations that predate this retrieval action.
CREATE OR REPLACE FUNCTION freeze_neighborhood_expected_marginal_value()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  prediction_history_limit CONSTANT INTEGER := 20;
  prior_relevant_ratio DOUBLE PRECISION := 0;
  prior_quality_ratio DOUBLE PRECISION := 0;
  prior_average_overlap DOUBLE PRECISION := 0;
  prior_count INTEGER := 0;
  reserved_quota INTEGER := 100;
  expected_value DOUBLE PRECISION := 0;
  gross_value DOUBLE PRECISION := 0;
  total_penalty DOUBLE PRECISION := 0;
BEGIN
  SELECT COALESCE(qr.quota_reserved, 100)
    INTO reserved_quota
    FROM query_runs qr
   WHERE qr.id = NEW.query_run_id;

  reserved_quota := GREATEST(COALESCE(reserved_quota, 100), 0);

  WITH recent_history AS (
    SELECT
      no.relevant_new_creator_ratio,
      no.quality_new_creator_ratio,
      COALESCE(no.result_set_overlap, 0) AS result_set_overlap
    FROM neighborhood_observations no
    WHERE no.neighborhood_key = NEW.neighborhood_key
      AND no.observed_at < NEW.observed_at
    ORDER BY no.observed_at DESC
    LIMIT prediction_history_limit
  )
  SELECT
    COALESCE(AVG(relevant_new_creator_ratio), 0)::double precision,
    COALESCE(AVG(quality_new_creator_ratio), 0)::double precision,
    COALESCE(AVG(result_set_overlap), 0)::double precision,
    COUNT(*)::integer
  INTO prior_relevant_ratio, prior_quality_ratio, prior_average_overlap, prior_count
  FROM recent_history;

  -- Keep cold-start expectation neutral. For observed history, mirror the existing
  -- shadow value-model weights while using only the bounded pre-run evidence above.
  IF prior_count > 0 THEN
    gross_value :=
      LEAST(100.0, prior_relevant_ratio * 2.0 * 25.0) +
      LEAST(100.0, prior_quality_ratio * 1.5 * 35.0) +
      LEAST(100.0, prior_relevant_ratio * 20.0) +
      LEAST(100.0, prior_quality_ratio * 15.0) +
      LEAST(100.0, GREATEST(0.0, 1.0 - prior_average_overlap) * 20.0);

    total_penalty :=
      (reserved_quota::double precision / 100.0) * 5.0 +
      GREATEST(0.0, LEAST(1.0, prior_average_overlap)) * 30.0;

    expected_value := GREATEST(0.0, ROUND((gross_value - total_penalty)::numeric, 1)::double precision);
  END IF;

  INSERT INTO neighborhood_marginal_values(
    neighborhood_key,
    query_run_id,
    expected_marginal_value,
    observed_marginal_value,
    coverage_gain,
    information_gain,
    frontier_expansion_gain,
    uncertainty_reduction,
    quota_cost,
    review_cost,
    redundancy_penalty,
    metadata
  )
  VALUES(
    NEW.neighborhood_key,
    NEW.query_run_id,
    expected_value,
    0,
    0,
    0,
    0,
    0,
    reserved_quota,
    0,
    0,
    jsonb_build_object(
      'prediction_frozen_at', now(),
      'prediction_history_limit', prediction_history_limit,
      'prediction_history_count', prior_count,
      'quota_basis', 'query_runs.quota_reserved'
    )
  )
  ON CONFLICT(query_run_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_freeze_neighborhood_expected_marginal_value
  ON retrieval_action_neighborhoods;
CREATE TRIGGER trg_freeze_neighborhood_expected_marginal_value
AFTER INSERT ON retrieval_action_neighborhoods
FOR EACH ROW
EXECUTE FUNCTION freeze_neighborhood_expected_marginal_value();

-- Completion-time analytics may update the observed side of the same row, but a
-- post-run calculation must never rewrite the already-frozen prediction.
CREATE OR REPLACE FUNCTION preserve_frozen_expected_marginal_value()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.metadata ? 'prediction_frozen_at' THEN
    NEW.expected_marginal_value := OLD.expected_marginal_value;
    NEW.metadata := OLD.metadata || COALESCE(NEW.metadata, '{}'::jsonb);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_preserve_frozen_expected_marginal_value
  ON neighborhood_marginal_values;
CREATE TRIGGER trg_preserve_frozen_expected_marginal_value
BEFORE UPDATE ON neighborhood_marginal_values
FOR EACH ROW
EXECUTE FUNCTION preserve_frozen_expected_marginal_value();

-- Phase 4: Segmented Discovery Health Diagnostics
CREATE TABLE IF NOT EXISTS neighborhood_health_diagnostics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_type TEXT NOT NULL,
  segment_key TEXT NOT NULL,
  valuable_new_creators INTEGER NOT NULL DEFAULT 0,
  quota_consumed INTEGER NOT NULL DEFAULT 0,
  yield_per_1000_quota REAL NOT NULL DEFAULT 0,
  saturation_score REAL NOT NULL DEFAULT 0,
  frontier_expansion_rate REAL NOT NULL DEFAULT 0,
  underexplored_quota_percent REAL NOT NULL DEFAULT 0,
  provenance_diversity REAL NOT NULL DEFAULT 0,
  coverage_gap_identified BOOLEAN NOT NULL DEFAULT false,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unq_health_diag_segment UNIQUE(segment_type, segment_key)
);

CREATE INDEX IF NOT EXISTS idx_health_diag_segment ON neighborhood_health_diagnostics(segment_type, segment_key);
CREATE INDEX IF NOT EXISTS idx_health_diag_time ON neighborhood_health_diagnostics(calculated_at);

-- Correct creator-size quota attribution at the persistence boundary. The TypeScript
-- observation payload contains per-band counts; this trigger applies the deterministic
-- largest-remainder method so integer rounding can never duplicate provider cost.
CREATE OR REPLACE FUNCTION conserve_creator_size_quota_attribution()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  breakdown JSONB := COALESCE(NEW.metadata->'size_band_breakdown', '{}'::jsonb);
  normalized_breakdown JSONB;
  total_weight INTEGER := 0;
  target_quota INTEGER := GREATEST(COALESCE(NEW.quota_consumed, 0), 0);
BEGIN
  IF jsonb_typeof(breakdown) IS DISTINCT FROM 'object' OR breakdown = '{}'::jsonb THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(GREATEST(COALESCE(NULLIF(value->>'total_count', '')::integer, 0), 0)), 0)::integer
    INTO total_weight
    FROM jsonb_each(breakdown);

  IF total_weight <= 0 OR target_quota = 0 THEN
    SELECT jsonb_object_agg(
      key,
      jsonb_set(value, '{attributed_quota}', to_jsonb(0::integer), true)
    )
    INTO normalized_breakdown
    FROM jsonb_each(breakdown);
  ELSE
    WITH weighted AS (
      SELECT
        key,
        value,
        GREATEST(COALESCE(NULLIF(value->>'total_count', '')::integer, 0), 0) AS weight,
        (target_quota::numeric * GREATEST(COALESCE(NULLIF(value->>'total_count', '')::integer, 0), 0) / total_weight::numeric) AS exact_share
      FROM jsonb_each(breakdown)
    ),
    based AS (
      SELECT
        key,
        value,
        FLOOR(exact_share)::integer AS base_quota,
        exact_share - FLOOR(exact_share) AS fractional_remainder
      FROM weighted
    ),
    remainder AS (
      SELECT GREATEST(target_quota - COALESCE(SUM(base_quota), 0), 0)::integer AS units_left
      FROM based
    ),
    ranked AS (
      SELECT
        b.*,
        ROW_NUMBER() OVER (ORDER BY b.fractional_remainder DESC, b.key ASC) AS remainder_rank,
        r.units_left
      FROM based b
      CROSS JOIN remainder r
    )
    SELECT jsonb_object_agg(
      key,
      jsonb_set(
        value,
        '{attributed_quota}',
        to_jsonb((base_quota + CASE WHEN remainder_rank <= units_left THEN 1 ELSE 0 END)::integer),
        true
      )
    )
    INTO normalized_breakdown
    FROM ranked;
  END IF;

  IF normalized_breakdown IS NOT NULL THEN
    NEW.metadata := jsonb_set(NEW.metadata, '{size_band_breakdown}', normalized_breakdown, true);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_conserve_creator_size_quota_attribution
  ON neighborhood_observations;
CREATE TRIGGER trg_conserve_creator_size_quota_attribution
BEFORE INSERT OR UPDATE OF metadata, quota_consumed ON neighborhood_observations
FOR EACH ROW
EXECUTE FUNCTION conserve_creator_size_quota_attribution();
