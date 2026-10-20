-- scripts/rollback_146_147.sql
-- Rollback for the Phase-1 evidence discovery migrations:
--   146_evidence_extraction_staging.sql  (staging domain widening + provider row)
--   147_discovery_probe_ledger.sql       (bounded probe ledger)
--
-- Safety contract:
--   * Single transaction: any conflict aborts the whole rollback with zero
--     partial effects.
--   * Non-destructive: never deletes staging data. If evidence-only domain
--     values (or rows referencing the evidence_extraction provider) exist,
--     the guard raises and the operator must archive/resolve them first.
--   * Restores the exact migration-112 CHECK definitions byte-for-byte
--     (verified in the scratch rollback transcript: pg_get_constraintdef
--     pre-state vs post-rollback are identical).
--   * Removes the schema_migrations rows for 146/147 so the version-keyed
--     runner can re-apply them cleanly afterwards.
--
-- NOT to be run against production without an approved maintenance window;
-- scratch-tested only (see docs/phase1/ROLLBACK_TEST_20261019.md).

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  conflicting_rows BIGINT;
BEGIN
  SELECT count(*) INTO conflicting_rows
    FROM discovery_candidate_staging
   WHERE discovery_mode = 'EVIDENCE_EXTRACTION'
      OR resolution_status = 'EVIDENCE_ONLY'
      OR candidate_type = 'SEARCH_TERM'
      OR provider_key = 'evidence_extraction';
  IF conflicting_rows > 0 THEN
    RAISE EXCEPTION
      'rollback_146_147 blocked: % discovery_candidate_staging row(s) use evidence-only values or the evidence_extraction provider; archive/resolve them first',
      conflicting_rows;
  END IF;
END $$;

-- 147 rollback: refuse to destroy probe history. The ledger is the durable
-- idempotency/attempt record; dropping it with rows would reset attempt numbers
-- and allow previously consumed probes to be replayed.
DO $$
DECLARE
  ledger_rows BIGINT := 0;
BEGIN
  IF to_regclass('discovery_probe_ledger') IS NOT NULL THEN
    SELECT count(*) INTO ledger_rows FROM discovery_probe_ledger;
  END IF;
  IF ledger_rows > 0 THEN
    RAISE EXCEPTION
      'rollback_146_147 blocked: % discovery_probe_ledger row(s) exist; archive them first',
      ledger_rows;
  END IF;
END $$;
DROP TABLE IF EXISTS discovery_probe_ledger;

-- 146 rollback: restore the exact migration-112 CHECK definitions.
ALTER TABLE discovery_candidate_staging
  DROP CONSTRAINT IF EXISTS discovery_candidate_staging_discovery_mode_check;
ALTER TABLE discovery_candidate_staging
  ADD CONSTRAINT discovery_candidate_staging_discovery_mode_check
  CHECK (discovery_mode IN ('DIRECT_YOUTUBE', 'EXTERNAL_OSINT')) NOT VALID;
ALTER TABLE discovery_candidate_staging
  VALIDATE CONSTRAINT discovery_candidate_staging_discovery_mode_check;

ALTER TABLE discovery_candidate_staging
  DROP CONSTRAINT IF EXISTS discovery_candidate_staging_resolution_status_check;
ALTER TABLE discovery_candidate_staging
  ADD CONSTRAINT discovery_candidate_staging_resolution_status_check
  CHECK (resolution_status IN ('PENDING', 'RESOLVED', 'FAILED', 'SKIPPED')) NOT VALID;
ALTER TABLE discovery_candidate_staging
  VALIDATE CONSTRAINT discovery_candidate_staging_resolution_status_check;

ALTER TABLE discovery_candidate_staging
  DROP CONSTRAINT IF EXISTS discovery_candidate_staging_candidate_type_check;
ALTER TABLE discovery_candidate_staging
  ADD CONSTRAINT discovery_candidate_staging_candidate_type_check
  CHECK (candidate_type IN ('CHANNEL_ID', 'HANDLE', 'VIDEO_ID', 'EXTERNAL_EVIDENCE')) NOT VALID;
ALTER TABLE discovery_candidate_staging
  VALIDATE CONSTRAINT discovery_candidate_staging_candidate_type_check;

-- 146 rollback: remove the provider registry row added by the widening.
-- (FK on discovery_candidate_staging.provider_key is ON DELETE RESTRICT; the
-- guard above already proved no staging row references it.)
DELETE FROM discovery_provider_registry
 WHERE provider_key = 'evidence_extraction'
   AND updated_by = 'system:migration-146';
DELETE FROM discovery_provider_registry
 WHERE provider_key = 'youtube-innertube'
   AND updated_by = 'system:migration-147';

-- Allow identical re-application of 146/147 by the version-keyed runner.
DELETE FROM schema_migrations WHERE version IN (146, 147);

COMMIT;
