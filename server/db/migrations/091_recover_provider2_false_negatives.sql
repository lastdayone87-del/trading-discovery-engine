-- Bounded recovery for machine NON_TRADING decisions made while Provider #2 was
-- active in autonomous discovery. This deliberately does NOT weaken the
-- classifier and does NOT reopen human or country rejections.
--
-- Provider #2 production window:
--   introduced: 2026-08-12T13:12:22Z (merge #203)
--   official Data API routing restored: 2026-08-13T18:45:43Z (#222)
--
-- Only the latest incident-window diagnostic for a channel is considered.
-- A row is eligible only when the machine decision is NON_TRADING and the
-- diagnostic is suspicious because evidence was degraded/insufficient, the
-- creator-level input was exceptionally thin, or positive trading evidence was
-- present despite the terminal negative decision. At most 25 channels are
-- queued, at low priority, staggered to protect official YouTube quota.

WITH latest_incident_diagnostic AS (
  SELECT DISTINCT ON (d.channel_id)
    d.channel_id,
    d.created_at AS diagnostic_created_at,
    d.enrichment_stage,
    d.normalized_input,
    d.decision,
    (
      CASE WHEN COALESCE((d.decision->'evidenceCollection'->>'degraded')::boolean, false) THEN 8 ELSE 0 END
      + CASE WHEN COALESCE(d.decision->'evidenceCollection'->>'sufficiency', 'MISSING') IN ('MISSING','INSUFFICIENT') THEN 6 ELSE 0 END
      + CASE WHEN COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(d.decision->'positiveEvidence')='array' THEN d.decision->'positiveEvidence' ELSE '[]'::jsonb END), 0) > 0 THEN 5 ELSE 0 END
      + CASE WHEN COALESCE(length(trim(d.normalized_input->>'description')), 0) = 0
          AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(d.normalized_input->'video_titles')='array' THEN d.normalized_input->'video_titles' ELSE '[]'::jsonb END), 0) <= 1
        THEN 4 ELSE 0 END
    ) AS suspicion_score
  FROM production_classification_diagnostics d
  JOIN channels c ON c.channel_id = d.channel_id
  WHERE d.created_at >= TIMESTAMPTZ '2026-08-12 13:12:22+00'
    AND d.created_at <  TIMESTAMPTZ '2026-08-13 18:45:43+00'
    AND c.trading_status = 'NON_TRADING'
    AND c.scan_status = 'SKIPPED_NON_TRADING'
    AND c.country_status <> 'REJECTED'
    AND COALESCE(d.decision->>'status','') = 'NON_TRADING'
    AND NOT EXISTS (
      SELECT 1
      FROM channel_review_decisions r
      WHERE r.channel_id = d.channel_id
        AND r.decision = 'REJECT'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM channel_reviews cr
      WHERE cr.channel_id = d.channel_id
        AND cr.state = 'REJECTED'
    )
  ORDER BY d.channel_id, d.created_at DESC
), bounded AS (
  SELECT *, row_number() OVER (
    ORDER BY suspicion_score DESC, diagnostic_created_at ASC, channel_id
  ) AS recovery_order
  FROM latest_incident_diagnostic
  WHERE suspicion_score > 0
  ORDER BY suspicion_score DESC, diagnostic_created_at ASC, channel_id
  LIMIT 25
)
INSERT INTO jobs(
  type, status, priority, payload, attempts, max_attempts, run_after,
  idempotency_key, created_at, updated_at
)
SELECT
  'FORCE_REVIEW_RESCAN',
  'PENDING',
  5,
  jsonb_build_object(
    'channelId', channel_id,
    'incidentRecovery', 'provider2_false_negative_v1',
    'diagnosticCreatedAt', diagnostic_created_at,
    'suspicionScore', suspicion_score,
    'enrichmentStage', enrichment_stage,
    'reasonCodes', jsonb_strip_nulls(jsonb_build_object(
      'providerDegraded', CASE WHEN COALESCE((decision->'evidenceCollection'->>'degraded')::boolean, false) THEN true ELSE NULL END,
      'evidenceSufficiency', CASE WHEN COALESCE(decision->'evidenceCollection'->>'sufficiency','MISSING') IN ('MISSING','INSUFFICIENT') THEN COALESCE(decision->'evidenceCollection'->>'sufficiency','MISSING') ELSE NULL END,
      'positiveEvidenceCount', CASE WHEN jsonb_typeof(decision->'positiveEvidence')='array' THEN jsonb_array_length(decision->'positiveEvidence') ELSE 0 END,
      'thinCreatorInput', CASE WHEN COALESCE(length(trim(normalized_input->>'description')), 0) = 0
        AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(normalized_input->'video_titles')='array' THEN normalized_input->'video_titles' ELSE '[]'::jsonb END), 0) <= 1 THEN true ELSE NULL END
    ))
  ),
  0,
  2,
  now() + ((recovery_order - 1) * INTERVAL '4 minutes'),
  'provider2-false-negative-recovery-v1:' || channel_id,
  now(),
  now()
FROM bounded
ON CONFLICT(idempotency_key) DO NOTHING;
