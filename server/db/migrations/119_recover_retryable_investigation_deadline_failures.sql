-- Recover only ENRICH_CHANNEL investigations that were terminalized by the
-- investigation deadline after a durable retryable infrastructure/provider
-- failure. The causal STEP_RETRYING event is required; a generic deadline
-- failure by itself is not sufficient evidence for recovery.

CREATE TEMP TABLE recover_retryable_investigation_deadlines ON COMMIT DROP AS
WITH retryable_failure_events AS (
  SELECT DISTINCT ON (e.step_id)
    e.step_id,
    e.investigation_id,
    e.payload->>'failureClass' AS prior_failure_class,
    e.occurred_at
  FROM investigation_events e
  WHERE e.event_type='STEP_RETRYING'
    AND e.step_id IS NOT NULL
    AND e.payload->>'failureClass' IN (
      'OperationalEnrichmentProviderError',
      'QUOTA_ALLOCATION_EXHAUSTED',
      'YOUTUBE_PROVIDERS_COOLING_DOWN',
      'YOUTUBE_PROVIDER_POOL_EXHAUSTED',
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'EAI_AGAIN',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'PROVIDER_COOLDOWN',
      'PROVIDER_CONCURRENCY_CAP_EXCEEDED',
      'BRAVE_API_RATE_LIMIT_429',
      'BRAVE_API_TIMEOUT',
      'BRAVE_API_NETWORK_FAILURE',
      'BRAVE_API_HTTP_500',
      'BRAVE_API_HTTP_502',
      'BRAVE_API_HTTP_503',
      'BRAVE_API_HTTP_504'
    )
  ORDER BY e.step_id,e.occurred_at DESC
), candidates AS (
  SELECT
    j.id AS job_id,
    j.payload->>'channelId' AS channel_id,
    s.id AS step_id,
    s.investigation_id,
    r.prior_failure_class
  FROM jobs j
  JOIN investigation_steps s ON s.job_id=j.id
  JOIN investigations i ON i.id=s.investigation_id
  JOIN retryable_failure_events r
    ON r.step_id=s.id AND r.investigation_id=s.investigation_id
  JOIN channels c ON c.channel_id=j.payload->>'channelId'
  WHERE j.type='ENRICH_CHANNEL'
    AND j.status='FAILED'
    AND j.last_error ILIKE '%Investigation deadline exceeded%'
    AND s.state='FAILED'
    AND s.failure_class='INVESTIGATION_DEADLINE_EXCEEDED'
    AND i.state='OPERATIONALLY_BLOCKED'
    AND r.occurred_at <= s.updated_at
    AND c.scan_status='FAILED'
    AND c.country_status <> 'REJECTED'
    AND c.trading_status NOT IN('NON_TRADING','HUMAN_REJECTED')
)
SELECT * FROM candidates;

-- Reopen the exact durable job. The failed deadline claim consumed one attempt,
-- so undo only that claim. Reset the retry epoch so the generic six-hour
-- transient ceiling starts from the recovered execution, while preserving all
-- append-only job_attempt history.
UPDATE jobs j
SET status='PENDING',
    attempts=GREATEST(0,j.attempts-1),
    run_after=now(),
    created_at=now(),
    locked_by=NULL,
    locked_at=NULL,
    last_error=NULL,
    completed_at=NULL,
    updated_at=now()
FROM recover_retryable_investigation_deadlines r
WHERE j.id=r.job_id
  AND j.status='FAILED';

-- Reopen the exact investigation step and retain the causal provider class so
-- startInvestigationStep can refresh future expired deadlines correctly.
UPDATE investigation_steps s
SET state='RETRYING',
    attempt_count=GREATEST(0,s.attempt_count-1),
    failure_class=r.prior_failure_class,
    worker_id=NULL,
    lease_expires_at=NULL,
    completed_at=NULL,
    recovery_generation=recovery_generation+1,
    updated_at=now()
FROM recover_retryable_investigation_deadlines r
WHERE s.id=r.step_id
  AND s.state='FAILED';

-- Reopen only the owning investigations and give the recovered step a fresh
-- deadline using the same bounded setting parser used by the existing recovery
-- migration. No unrelated OPERATIONALLY_BLOCKED investigation is touched.
UPDATE investigations i
SET state='ACTIVE',
    completed_at=NULL,
    deadline_at=now()+(
      COALESCE(
        (SELECT CASE
           WHEN normalized_value <> '0'
             AND length(normalized_value) BETWEEN 1 AND 10
             AND (length(normalized_value) < 10 OR normalized_value <= '2147483647')
             THEN normalized_value::INTEGER
           ELSE NULL
         END
         FROM (
           SELECT CASE
             WHEN setting_value ~ '^[0-9]+$'
               THEN COALESCE(NULLIF(regexp_replace(setting_value,'^0+','','g'),''),'0')
             ELSE '0'
           END AS normalized_value
           FROM app_settings
           WHERE setting_key='investigation_deadline_minutes'
           LIMIT 1
         ) setting
        ),
        30
      )::text || ' minutes'
    )::interval,
    recovery_generation=s.recovery_generation,
    updated_at=now()
FROM investigation_steps s
JOIN recover_retryable_investigation_deadlines r ON r.step_id=s.id
WHERE i.id=r.investigation_id
  AND i.state='OPERATIONALLY_BLOCKED';

-- Return only causally proven channel projections to a recoverable operational
-- state. Trading/country semantics and human decisions are preserved.
UPDATE channels c
SET scan_status='ENRICHMENT_PENDING',
    updated_at=now()
FROM recover_retryable_investigation_deadlines r
WHERE c.channel_id=r.channel_id
  AND c.scan_status='FAILED'
  AND c.country_status <> 'REJECTED'
  AND c.trading_status NOT IN('NON_TRADING','HUMAN_REJECTED');

-- Preserve an immutable audit event for each causal recovery. Migration 086's
-- recovery-generation trigger namespaces the key automatically.
INSERT INTO investigation_events(
  event_key,investigation_id,step_id,event_type,payload,policy_version
)
SELECT
  'investigation:'||s.investigation_id::text||':step:'||s.id::text||':deadline-causal-recovered',
  s.investigation_id,
  s.id,
  'INVESTIGATION_RECOVERED',
  jsonb_build_object(
    'jobId',s.job_id,
    'reason','RETRYABLE_INFRASTRUCTURE_PRECEDED_DEADLINE',
    'priorFailureClass',r.prior_failure_class,
    'recoveryGeneration',s.recovery_generation
  ),
  s.policy_version
FROM investigation_steps s
JOIN recover_retryable_investigation_deadlines r ON r.step_id=s.id
ON CONFLICT(event_key) DO NOTHING;
