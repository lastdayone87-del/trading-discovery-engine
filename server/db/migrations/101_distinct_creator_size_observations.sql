-- Checkpoint 2 hardening: creator-size diagnostics are creator-based, not sighting-based.
-- A channel can legitimately appear on multiple YouTube result pages in the same
-- query run. Recompute the persisted size-band breakdown from DISTINCT channel IDs
-- so repeated page sightings cannot skew band population or quota attribution.

CREATE OR REPLACE FUNCTION conserve_creator_size_quota_attribution()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  breakdown JSONB := '{}'::jsonb;
  normalized_breakdown JSONB;
  total_weight INTEGER := 0;
  target_quota INTEGER := GREATEST(COALESCE(NEW.quota_consumed, 0), 0);
  exact_relevant_new INTEGER := 0;
  exact_quality_new INTEGER := 0;
BEGIN
  WITH parsed AS (
    SELECT DISTINCT ON (s.channel_id)
      s.channel_id,
      s.was_known,
      c.trading_status,
      COALESCE(c.quality_score, 0) AS quality_score,
      CASE
        WHEN c.subscriber_count IS NULL OR btrim(c.subscriber_count) = '' THEN NULL
        WHEN upper(btrim(c.subscriber_count)) ~ '^[0-9]+(\.[0-9]+)?K$'
          THEN regexp_replace(upper(btrim(c.subscriber_count)), 'K$', '')::numeric * 1000
        WHEN upper(btrim(c.subscriber_count)) ~ '^[0-9]+(\.[0-9]+)?M$'
          THEN regexp_replace(upper(btrim(c.subscriber_count)), 'M$', '')::numeric * 1000000
        WHEN btrim(c.subscriber_count) ~ '^[0-9]+(\.[0-9]+)?$'
          THEN btrim(c.subscriber_count)::numeric
        ELSE NULL
      END AS subscriber_numeric
    FROM channel_sightings s
    JOIN channels c ON c.channel_id = s.channel_id
    WHERE s.query_run_id = NEW.query_run_id
    ORDER BY s.channel_id, s.page_number ASC NULLS FIRST, s.result_rank ASC NULLS FIRST
  ), classified AS (
    SELECT
      channel_id,
      was_known,
      trading_status,
      quality_score,
      CASE
        WHEN subscriber_numeric IS NULL OR subscriber_numeric < 0 THEN 'UNKNOWN'
        WHEN subscriber_numeric < 10000 THEN 'MICRO_<10K'
        WHEN subscriber_numeric < 100000 THEN 'MID_10K_100K'
        WHEN subscriber_numeric < 500000 THEN 'LARGE_100K_500K'
        ELSE 'MAJOR_500K+'
      END AS size_band
    FROM parsed
  ), band_counts AS (
    SELECT
      size_band,
      COUNT(*)::integer AS total_count,
      COUNT(*) FILTER (
        WHERE was_known = false
          AND trading_status = 'TRADING_CONFIRMED'
      )::integer AS relevant_new_count,
      COUNT(*) FILTER (
        WHERE was_known = false
          AND trading_status = 'TRADING_CONFIRMED'
          AND quality_score >= 55
      )::integer AS quality_new_count
    FROM classified
    GROUP BY size_band
  )
  SELECT
    COALESCE(
      jsonb_object_agg(
        size_band,
        jsonb_build_object(
          'quality_new_count', quality_new_count,
          'relevant_new_count', relevant_new_count,
          'total_count', total_count,
          'attributed_quota', 0
        )
      ),
      '{}'::jsonb
    ),
    COALESCE(SUM(relevant_new_count), 0)::integer,
    COALESCE(SUM(quality_new_count), 0)::integer,
    COALESCE(SUM(total_count), 0)::integer
  INTO breakdown, exact_relevant_new, exact_quality_new, total_weight
  FROM band_counts;

  -- Persist exact distinct-creator intersections as the canonical metadata and
  -- keep the ratio columns aligned with those same distinct counts.
  NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb)
    || jsonb_build_object(
      'relevant_new_count', exact_relevant_new,
      'quality_new_count', exact_quality_new,
      'size_band_breakdown', breakdown,
      'creator_size_population_basis', 'distinct_channel_id'
    );

  IF NEW.total_results > 0 THEN
    NEW.relevant_new_creator_ratio := LEAST(1.0, exact_relevant_new::double precision / NEW.total_results::double precision);
    NEW.quality_new_creator_ratio := LEAST(1.0, exact_quality_new::double precision / NEW.total_results::double precision);
  ELSE
    NEW.relevant_new_creator_ratio := 0;
    NEW.quality_new_creator_ratio := 0;
  END IF;

  IF breakdown = '{}'::jsonb THEN
    RETURN NEW;
  END IF;

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
        (target_quota::numeric
          * GREATEST(COALESCE(NULLIF(value->>'total_count', '')::integer, 0), 0)
          / total_weight::numeric) AS exact_share
      FROM jsonb_each(breakdown)
    ), based AS (
      SELECT
        key,
        value,
        FLOOR(exact_share)::integer AS base_quota,
        exact_share - FLOOR(exact_share) AS fractional_remainder
      FROM weighted
    ), remainder AS (
      SELECT GREATEST(target_quota - COALESCE(SUM(base_quota), 0), 0)::integer AS units_left
      FROM based
    ), ranked AS (
      SELECT
        b.*,
        ROW_NUMBER() OVER (
          ORDER BY b.fractional_remainder DESC, b.key ASC
        ) AS remainder_rank,
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
    NEW.metadata := jsonb_set(
      NEW.metadata,
      '{size_band_breakdown}',
      normalized_breakdown,
      true
    );
  END IF;

  RETURN NEW;
END;
$$;
