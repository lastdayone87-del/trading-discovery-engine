-- Semantic-primary channel admission gate.
--
-- Candidates are captured before any channels row exists. The semantic judge
-- decides whether the creator qualifies for the trading discovery pipeline.
-- Missing-evidence holds are bounded by next_check_at/expires_at; ambiguity is
-- admitted (never held) and handled by the post-admission classifier.

ALTER TABLE channels ADD COLUMN IF NOT EXISTS admitted_at timestamptz;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS admission_status text;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS admission_decision_id uuid;

-- Existing admitted rows keep their current behavior. The two pre-admission
-- holding statuses remain historical until the revalidation script runs.
UPDATE channels
   SET admitted_at = COALESCE(first_seen, now()),
       admission_status = 'LEGACY_ADMITTED'
 WHERE admitted_at IS NULL
   AND scan_status NOT IN ('INTAKE_DEFERRED', 'CLASSIFICATION_PENDING');

-- LEGACY_HOLD is provenance, not a permanent rejection. INTAKE_DEFERRED rows
-- are revalidated by the opt-in script; CLASSIFICATION_PENDING rows remain on
-- their existing classification path and can also be selected explicitly with
-- --include-classification-pending.
UPDATE channels
   SET admission_status = 'LEGACY_HOLD'
 WHERE admission_status IS NULL
   AND scan_status IN ('INTAKE_DEFERRED', 'CLASSIFICATION_PENDING');

CREATE INDEX IF NOT EXISTS channels_admission_status_idx
  ON channels (admission_status, first_seen DESC);

CREATE TABLE IF NOT EXISTS semantic_admission_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_key text NOT NULL UNIQUE,
  channel_id text NOT NULL,
  channel_name text NOT NULL,
  youtube_url text NOT NULL,
  source text NOT NULL,
  query_id integer,
  query_run_id uuid,
  job_id uuid,
  page_number integer,
  result_rank integer,
  target_country text,
  matched_document jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_observation jsonb NOT NULL DEFAULT '{}'::jsonb,
  declared_language text,
  status text NOT NULL DEFAULT 'PENDING',
  decision text,
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_snapshot jsonb,
  evidence_hash text,
  semantic_output jsonb,
  semantic_model text,
  attempts integer NOT NULL DEFAULT 0,
  next_check_at timestamptz,
  expires_at timestamptz,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS semantic_admission_candidates_due_idx
  ON semantic_admission_candidates (status, next_check_at)
  WHERE status IN ('PENDING', 'WAITING_EVIDENCE', 'PROVIDER_DEFERRED');

CREATE INDEX IF NOT EXISTS semantic_admission_candidates_channel_idx
  ON semantic_admission_candidates (channel_id, created_at DESC);

CREATE INDEX IF NOT EXISTS semantic_admission_candidates_run_idx
  ON semantic_admission_candidates (query_run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS semantic_admission_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid REFERENCES semantic_admission_candidates(id) ON DELETE SET NULL,
  decision_key text NOT NULL UNIQUE,
  channel_id text NOT NULL,
  decision text NOT NULL,
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_hash text,
  semantic_output jsonb,
  policy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS semantic_admission_decisions_channel_idx
  ON semantic_admission_decisions (channel_id, created_at DESC);

INSERT INTO app_settings (setting_key, setting_value)
VALUES ('channel_admission_mode', 'OFF')
ON CONFLICT (setting_key) DO NOTHING;

-- One-time quarantine of the contaminated extracted queries observed in
-- production (casino/martingale source videos). The semantic admission gate is
-- the primary defense; this also stops the known bad queries from re-entering
-- the planner before revalidation.
UPDATE query_library
   SET collection='REJECTED', status='REJECTED',
       generation_metadata=COALESCE(generation_metadata,'{}'::jsonb) || '{"queryHold":{"source":"semantic-admission-migration-178","reasonCodes":["GAMBLING_SOURCE_VIDEO","NO_CONCRETE_TRADING_ANCHOR"]}}'::jsonb
 WHERE normalized_query IN (
   'systems keep showing up in trading',
   'martingale betting system in trading'
 );

UPDATE extracted_query_candidates
   SET decision='REJECTED',
       standalone_eligible=false,
       rejection_reasons='["GAMBLING_SOURCE_VIDEO","NO_CONCRETE_TRADING_ANCHOR"]'::jsonb,
       updated_at=now()
 WHERE normalized_text IN (
   'systems keep showing up in trading',
   'martingale betting system in trading'
 );

CREATE TABLE IF NOT EXISTS semantic_admission_model_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS semantic_admission_model_calls_day_idx
  ON semantic_admission_model_calls (created_at);

CREATE TABLE IF NOT EXISTS semantic_admission_sightings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES semantic_admission_candidates(id) ON DELETE CASCADE,
  query_run_id uuid,
  page_number integer,
  result_rank integer,
  matched_document jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS semantic_admission_sightings_run_page_idx
  ON semantic_admission_sightings (query_run_id, page_number);
