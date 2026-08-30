-- Historical repair for the target-country boundary defect fixed by PR #376.
-- The old boundary could turn an inference whose own decision was UNCERTAIN or
-- LIKELY into country_status=REJECTED merely because its best-current detected
-- country differed from the pinned discovery country. That terminal projection
-- then prevented later enrichment/community work.
--
-- This migration is deliberately evidence-bound. It requires the durable
-- COUNTRY_VALIDATION trail itself to record BOTH the pre-boundary unresolved
-- status and the target-country boundary rejection. Genuine confirmed
-- mismatches and exclusion-policy rejections do not satisfy this predicate.

CREATE TABLE IF NOT EXISTS historical_country_boundary_recovery_events (
  event_key TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  prior_country_status TEXT NOT NULL,
  restored_country_status TEXT NOT NULL,
  prior_scan_status TEXT NOT NULL,
  resulting_scan_status TEXT NOT NULL,
  evidence_details TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS historical_country_boundary_recovery_channel_idx
  ON historical_country_boundary_recovery_events(channel_id, created_at DESC);

CREATE TEMP TABLE _historical_uncertain_country_boundary_recovery ON COMMIT DROP AS
WITH country_trails AS (
  SELECT DISTINCT ON (c.channel_id)
    c.channel_id,
    c.country_status AS prior_country_status,
    c.scan_status AS prior_scan_status,
    c.trading_status,
    c.discord_validation_status,
    c.country,
    c.channel_name,
    c.youtube_url,
    c.discovery_source,
    c.subscriber_count,
    c.channel_thumbnail_url,
    trail->>'details' AS evidence_details,
    CASE
      WHEN trail->>'details' ~* '\(Status:[[:space:]]*LIKELY\)' THEN 'LIKELY'
      WHEN trail->>'details' ~* '\(Status:[[:space:]]*UNCERTAIN\)' THEN 'UNCERTAIN'
      ELSE NULL
    END AS restored_country_status
  FROM channels c
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.inspection_trail, '[]'::jsonb)) trail
  WHERE c.country_status='REJECTED'
    AND trail->>'step'='COUNTRY_VALIDATION'
    AND trail->>'details' ILIKE '%Target Country Boundary: REJECTED%'
    AND (
      trail->>'details' ~* '\(Status:[[:space:]]*UNCERTAIN\)'
      OR trail->>'details' ~* '\(Status:[[:space:]]*LIKELY\)'
    )
    AND c.trading_status IS DISTINCT FROM 'NON_TRADING'
    AND c.trading_status IS DISTINCT FROM 'HUMAN_REJECTED'
  ORDER BY c.channel_id, COALESCE((trail->>'timestamp')::timestamptz, c.updated_at) DESC
)
SELECT *,
  CASE
    WHEN COALESCE(NULLIF(regexp_replace(COALESCE(subscriber_count,''),'[^0-9]','','g'),''),'0')::numeric > 0
      AND COALESCE(NULLIF(regexp_replace(COALESCE(subscriber_count,''),'[^0-9]','','g'),''),'0')::numeric < 30
      THEN 'SKIPPED_LOW_AUDIENCE'
    ELSE 'ENRICHMENT_PENDING'
  END AS resulting_scan_status
FROM country_trails
WHERE restored_country_status IS NOT NULL;

-- Restore the unresolved country inference. Preserve positive trading semantics.
-- Low-audience rows remain low-audience; every other recovered row returns to a
-- machine-owned enrichment state so the downstream evidence/Discord path can run.
UPDATE channels c
SET country_status=recover.restored_country_status,
    scan_status=recover.resulting_scan_status,
    discord_validation_status=CASE
      WHEN recover.resulting_scan_status='SKIPPED_LOW_AUDIENCE' THEN c.discord_validation_status
      WHEN c.discord_validation_status IN ('COMPLETED','SUCCEEDED') THEN c.discord_validation_status
      ELSE 'NOT_STARTED'
    END,
    last_checked=now(),
    inspection_trail=COALESCE(c.inspection_trail,'[]'::jsonb)||jsonb_build_array(jsonb_build_object(
      'step','COUNTRY_VALIDATION',
      'title','Historical Country Boundary Recovery',
      'status','FOUND',
      'details','Restored unresolved country inference after removal of the legacy target-country hard-rejection projection; downstream evidence acquisition re-enabled where eligible.',
      'timestamp',now()
    )),
    updated_at=now()
FROM _historical_uncertain_country_boundary_recovery recover
WHERE c.channel_id=recover.channel_id
  AND c.country_status=recover.prior_country_status;

INSERT INTO historical_country_boundary_recovery_events(
  event_key,channel_id,prior_country_status,restored_country_status,
  prior_scan_status,resulting_scan_status,evidence_details,policy_version
)
SELECT
  'historical-country-boundary:'||recover.channel_id,
  recover.channel_id,
  recover.prior_country_status,
  recover.restored_country_status,
  recover.prior_scan_status,
  recover.resulting_scan_status,
  recover.evidence_details,
  'target-country-boundary-recovery-v1'
FROM _historical_uncertain_country_boundary_recovery recover
ON CONFLICT(event_key) DO NOTHING;

-- Re-enable the ordinary enrichment owner only for recovered rows that are not
-- low-audience and do not already have active enrichment/community ownership.
-- Set candidate enrichmentStage to 0 so candidateAlreadyEnriched evaluates to false,
-- ensuring normal fresh metadata acquisition via fetchYouTubeChannelEnrichment().
INSERT INTO jobs(type,payload,priority,max_attempts,run_after,idempotency_key)
SELECT
  'ENRICH_CHANNEL',
  jsonb_build_object(
    'channelId',recover.channel_id,
    'targetCountry',recover.country,
    'source',COALESCE(recover.discovery_source,'recovery'),
    'enrichmentStage',1,
    'evidenceAction','CHANNEL_RECENT_METADATA',
    'candidate',jsonb_build_object(
      'channelId',recover.channel_id,
      'channelName',recover.channel_name,
      'youtubeUrl',recover.youtube_url,
      'locationTag',recover.country,
      'description','',
      'videoTitles',jsonb_build_array(),
      'channelLinks',jsonb_build_array(),
      'subscriberCount',recover.subscriber_count,
      'channelThumbnailUrl',recover.channel_thumbnail_url,
      'enrichmentStage',0
    ),
    'recoveryReasonCodes',jsonb_build_array('LEGACY_TARGET_COUNTRY_BOUNDARY_FALSE_REJECTION')
  ),
  10,
  4,
  now(),
  'historical-country-boundary-recovery:'||recover.channel_id
FROM _historical_uncertain_country_boundary_recovery recover
WHERE recover.resulting_scan_status='ENRICHMENT_PENDING'
  AND NOT EXISTS (
    SELECT 1 FROM jobs active_job
    WHERE active_job.payload->>'channelId'=recover.channel_id
      AND active_job.type IN ('ENRICH_CHANNEL','POST_APPROVAL_ENRICH','FORCE_REVIEW_RESCAN','RETRY_COMMUNITY_ACQUISITION')
      AND active_job.status IN ('PENDING','PROCESSING')
  )
ON CONFLICT(idempotency_key) DO NOTHING;
