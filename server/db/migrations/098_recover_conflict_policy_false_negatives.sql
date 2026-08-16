-- Audited recovery for machine NON_TRADING rows created before the conflict-aware
-- classifier policy shipped in #261. This reuses the existing governed
-- CLASSIFICATION_FALSE_NEGATIVE_RESCAN worker, which is single-consumer,
-- production-backlog gated, provider-health gated, and reserves official
-- enrichment quota before claiming each job.
--
-- This migration never reopens country or human rejections. It queues only rows
-- whose latest diagnostic contains substantive positive trading evidence plus a
-- contradiction pattern that the pre-#261 policy could terminally mis-handle.
-- Historical diagnostics are append-only; the recovery worker performs a fresh
-- explicit recheck and writes a new decision rather than rewriting the old one.

WITH latest_machine_non_trading AS (
  SELECT DISTINCT ON (d.channel_id)
    d.channel_id,
    d.created_at AS diagnostic_created_at,
    d.enrichment_stage,
    d.evidence_items,
    d.decision,
    COALESCE((
      SELECT sum(abs(COALESCE(NULLIF(item->>'finalWeight','')::numeric, 0)))
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(d.evidence_items)='array' THEN d.evidence_items ELSE '[]'::jsonb END
      ) item
      WHERE item->>'polarity'='POSITIVE'
        AND jsonb_array_length(CASE WHEN jsonb_typeof(item->'rawMatches')='array' THEN item->'rawMatches' ELSE '[]'::jsonb END) > 0
    ),0) AS positive_weight,
    COALESCE((
      SELECT count(*)
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(d.evidence_items)='array' THEN d.evidence_items ELSE '[]'::jsonb END
      ) item
      WHERE item->>'polarity'='POSITIVE'
        AND jsonb_array_length(CASE WHEN jsonb_typeof(item->'rawMatches')='array' THEN item->'rawMatches' ELSE '[]'::jsonb END) > 0
    ),0) AS positive_count,
    COALESCE((
      SELECT sum(abs(COALESCE(NULLIF(item->>'finalWeight','')::numeric, 0)))
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(d.evidence_items)='array' THEN d.evidence_items ELSE '[]'::jsonb END
      ) item
      WHERE item->>'polarity'='NEGATIVE'
        AND item->>'category'='IRRELEVANT_DOMAIN'
    ),0) AS irrelevant_negative_weight,
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(d.evidence_items)='array' THEN d.evidence_items ELSE '[]'::jsonb END
      ) item
      WHERE item->>'polarity'='NEGATIVE'
        AND item->>'category' IN ('HYPE_SPECULATION','NON_TRADING_ADJACENT')
        AND abs(COALESCE(NULLIF(item->>'finalWeight','')::numeric,0)) >= 20
    ) AS has_non_terminal_heavy_negative
  FROM production_classification_diagnostics d
  JOIN channels c ON c.channel_id=d.channel_id
  WHERE c.trading_status='NON_TRADING'
    AND c.scan_status='SKIPPED_NON_TRADING'
    AND c.country_status<>'REJECTED'
    AND d.created_at < TIMESTAMPTZ '2026-08-16 12:38:46+00'
    AND COALESCE(d.decision->>'status','')='NON_TRADING'
    AND NOT EXISTS (
      SELECT 1 FROM channel_review_decisions r
      WHERE r.channel_id=d.channel_id AND r.decision='REJECT'
    )
    AND NOT EXISTS (
      SELECT 1 FROM channel_reviews cr
      WHERE cr.channel_id=d.channel_id AND cr.state='REJECTED'
    )
  ORDER BY d.channel_id,d.created_at DESC
), suspicious AS (
  SELECT *,
    CASE
      WHEN has_non_terminal_heavy_negative THEN 3
      WHEN positive_weight > irrelevant_negative_weight THEN 2
      WHEN positive_count >= 2 AND positive_weight >= 20 THEN 1
      ELSE 0
    END AS suspicion_tier
  FROM latest_machine_non_trading
  WHERE positive_count > 0
), bounded AS (
  SELECT *,row_number() OVER(
    ORDER BY suspicion_tier DESC,positive_weight DESC,diagnostic_created_at ASC,channel_id
  ) recovery_order
  FROM suspicious
  WHERE suspicion_tier > 0
  ORDER BY suspicion_tier DESC,positive_weight DESC,diagnostic_created_at ASC,channel_id
  LIMIT 100
)
INSERT INTO jobs(
  type,status,priority,payload,attempts,max_attempts,run_after,
  idempotency_key,created_at,updated_at
)
SELECT
  'CLASSIFICATION_FALSE_NEGATIVE_RESCAN',
  'PENDING',
  0,
  jsonb_build_object(
    'channelId',channel_id,
    'incidentRecovery','conflict_aware_non_trading_v2',
    'diagnosticCreatedAt',diagnostic_created_at,
    'suspicionTier',suspicion_tier,
    'positiveEvidenceCount',positive_count,
    'positiveWeight',positive_weight,
    'irrelevantNegativeWeight',irrelevant_negative_weight,
    'hadHeavyPromotionalOrAdjacentNegative',has_non_terminal_heavy_negative,
    'enrichmentStage',enrichment_stage,
    'policyFix','pull_request_261'
  ),
  0,
  2,
  now()+((recovery_order-1)*INTERVAL '4 minutes'),
  'classification-false-negative-recovery-v2:'||channel_id,
  now(),
  now()
FROM bounded
ON CONFLICT(idempotency_key) DO NOTHING;

-- Honest Discord semantics for an upstream trading-classification skip.
-- The Discord crawler did not run, so the persisted Discord state must not imply
-- that Discord itself was inspected and classified NON_TRADING. Existing enum
-- values already support the truthful compatibility projection: UNCERTAIN at the
-- legacy top level, with every independent Discord dimension NOT_CHECKED.
UPDATE channels
SET discord_status='UNCERTAIN',
    discord_invite=NULL,
    discord_discovery_status='NOT_DISCOVERED',
    discord_resolution_status='NOT_ATTEMPTED',
    discord_liveness_status='NOT_CHECKED',
    discord_relevance_status='NOT_CHECKED',
    discord_validation_status='NOT_ATTEMPTED'
WHERE scan_status='SKIPPED_NON_TRADING'
  AND trading_status='NON_TRADING'
  AND discord_invite IS NULL;

-- Enforce the same invariant for future upstream skips even if an application
-- caller accidentally supplies the old compatibility value NON_TRADING.
CREATE OR REPLACE FUNCTION normalize_upstream_skipped_discord_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.scan_status='SKIPPED_NON_TRADING'
     AND NEW.trading_status='NON_TRADING'
     AND NEW.discord_invite IS NULL THEN
    NEW.discord_status := 'UNCERTAIN';
    NEW.discord_discovery_status := 'NOT_DISCOVERED';
    NEW.discord_resolution_status := 'NOT_ATTEMPTED';
    NEW.discord_liveness_status := 'NOT_CHECKED';
    NEW.discord_relevance_status := 'NOT_CHECKED';
    NEW.discord_validation_status := 'NOT_ATTEMPTED';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS channels_normalize_upstream_skipped_discord_state ON channels;
CREATE TRIGGER channels_normalize_upstream_skipped_discord_state
BEFORE INSERT OR UPDATE OF trading_status,scan_status,discord_status,discord_invite,
  discord_discovery_status,discord_resolution_status,discord_liveness_status,
  discord_relevance_status,discord_validation_status
ON channels
FOR EACH ROW
EXECUTE FUNCTION normalize_upstream_skipped_discord_state();