-- Retire legacy Phase B retrieval-assignment observations that were captured
-- before deployment-specific sampling policy validation was enforced.
--
-- These observations are non-authoritative audit side-channel work. Invalid
-- sampling identity/salt/version can never produce a valid cohort assignment,
-- so repeatedly returning them to PENDING only creates an infinite retry loop.
-- Preserve the original payload and queue metadata in an immutable retirement
-- ledger, then remove the retired rows from the active completion queue.

CREATE TABLE IF NOT EXISTS phase_b_observation_retirements (
  observation_key TEXT PRIMARY KEY,
  observation_type TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  prior_status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  run_after TIMESTAMPTZ NOT NULL,
  last_error TEXT,
  result_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  retirement_reason TEXT NOT NULL,
  retired_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE phase_b_observation_retirements IS
  'Immutable audit ledger for Phase B observations intentionally retired from the active retry queue because their stored payload can never produce a valid observation.';

WITH invalid AS (
  SELECT o.*
    FROM phase_b_observation_outbox o
   WHERE o.observation_type = 'RETRIEVAL_ASSIGNMENT'
     AND o.status <> 'COMPLETED'
     AND (
       jsonb_typeof(o.payload->'policy'->'policyKey') IS DISTINCT FROM 'string'
       OR COALESCE(btrim(o.payload->'policy'->>'policyKey'), '') = ''
       OR jsonb_typeof(o.payload->'policy'->'salt') IS DISTINCT FROM 'string'
       OR COALESCE(btrim(o.payload->'policy'->>'salt'), '') = ''
       OR CASE
            WHEN jsonb_typeof(o.payload->'policy'->'version') = 'number' THEN
              (o.payload->'policy'->>'version')::numeric <= 0
              OR trunc((o.payload->'policy'->>'version')::numeric) <> (o.payload->'policy'->>'version')::numeric
            ELSE TRUE
          END
     )
), archived AS (
  INSERT INTO phase_b_observation_retirements (
    observation_key, observation_type, channel_id, payload, prior_status,
    attempts, run_after, last_error, result_reference, created_at, updated_at,
    completed_at, retirement_reason
  )
  SELECT observation_key, observation_type, channel_id, payload, status,
         attempts, run_after, last_error, result_reference, created_at, updated_at,
         completed_at, 'INVALID_RETRIEVAL_SAMPLING_POLICY'
    FROM invalid
  ON CONFLICT (observation_key) DO NOTHING
  RETURNING observation_key
)
DELETE FROM phase_b_observation_outbox o
 USING phase_b_observation_retirements r
 WHERE o.observation_key = r.observation_key
   AND r.retirement_reason = 'INVALID_RETRIEVAL_SAMPLING_POLICY'
   AND o.observation_type = 'RETRIEVAL_ASSIGNMENT'
   AND o.status <> 'COMPLETED'
   AND (
     jsonb_typeof(o.payload->'policy'->'policyKey') IS DISTINCT FROM 'string'
     OR COALESCE(btrim(o.payload->'policy'->>'policyKey'), '') = ''
     OR jsonb_typeof(o.payload->'policy'->'salt') IS DISTINCT FROM 'string'
     OR COALESCE(btrim(o.payload->'policy'->>'salt'), '') = ''
     OR CASE
          WHEN jsonb_typeof(o.payload->'policy'->'version') = 'number' THEN
            (o.payload->'policy'->>'version')::numeric <= 0
            OR trunc((o.payload->'policy'->>'version')::numeric) <> (o.payload->'policy'->>'version')::numeric
          ELSE TRUE
        END
   );
