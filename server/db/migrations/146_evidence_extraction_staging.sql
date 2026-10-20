-- Migration 146: Evidence-first discovery Phase 1 — staging domain widening.
--
-- Recon gap found (plan §5 fallback): discovery_candidate_staging CHECK
-- constraints from migration 112 only admit Brave-lane values, so the
-- approved evidence-extraction path cannot stage its distinct values without
-- this additive, expand-first widening:
--   * discovery_mode 'EVIDENCE_EXTRACTION'  (Brave: DIRECT_YOUTUBE / EXTERNAL_OSINT)
--   * resolution_status 'EVIDENCE_ONLY'     (never 'PENDING': the Brave backlog
--     counter `checkBraveControlPlane` counts resolution_status='PENDING', and
--     the RESOLVE_STAGED_CANDIDATE claim path selects only 'PENDING'. Rows here
--     are inert evidence records, never channel-resolution work items.)
--   * candidate_type 'SEARCH_TERM'          (extracted terms/phrases/handles are
--     not channel locators; mislabeling them as EXTERNAL_EVIDENCE would corrupt
--     Phase 2 probe-ledger reads)
-- plus the provider registry row the staging FK requires.
--
-- Additive only: no data is rewritten, no rows are deleted, no column is
-- dropped, and no app_settings row is created. discovery_extraction_enabled
-- remains operator-managed and absent => OFF.

ALTER TABLE discovery_candidate_staging
  DROP CONSTRAINT IF EXISTS discovery_candidate_staging_discovery_mode_check;
ALTER TABLE discovery_candidate_staging
  ADD CONSTRAINT discovery_candidate_staging_discovery_mode_check
  CHECK (discovery_mode IN ('DIRECT_YOUTUBE', 'EXTERNAL_OSINT', 'EVIDENCE_EXTRACTION')) NOT VALID;

ALTER TABLE discovery_candidate_staging
  DROP CONSTRAINT IF EXISTS discovery_candidate_staging_resolution_status_check;
ALTER TABLE discovery_candidate_staging
  ADD CONSTRAINT discovery_candidate_staging_resolution_status_check
  CHECK (resolution_status IN ('PENDING', 'RESOLVED', 'FAILED', 'SKIPPED', 'EVIDENCE_ONLY')) NOT VALID;

ALTER TABLE discovery_candidate_staging
  DROP CONSTRAINT IF EXISTS discovery_candidate_staging_candidate_type_check;
ALTER TABLE discovery_candidate_staging
  ADD CONSTRAINT discovery_candidate_staging_candidate_type_check
  CHECK (candidate_type IN ('CHANNEL_ID', 'HANDLE', 'VIDEO_ID', 'EXTERNAL_EVIDENCE', 'SEARCH_TERM')) NOT VALID;

INSERT INTO discovery_provider_registry (
  provider_key, provider_family, provider_kind, capabilities, quota_domain,
  terms_reference, mode, daily_cost_cap, updated_by
) VALUES (
  'evidence_extraction', 'evidence', 'EVIDENCE',
  '["EXTRACT_METADATA_EVIDENCE"]'::jsonb, 'LOCAL_COMPUTE',
  NULL, 'SHADOW', 0, 'system:migration-146'
) ON CONFLICT (provider_key) DO NOTHING;
