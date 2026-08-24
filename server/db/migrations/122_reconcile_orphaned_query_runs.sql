-- Historical repair only: an active query run with a terminal FAILED SEARCH_YOUTUBE
-- job has no remaining execution owner. Preserve the error and close the run; never
-- touch PENDING/PROCESSING jobs, semantic decisions, or provider configuration.
CREATE TEMP TABLE _orphaned_query_run_reconciliation ON COMMIT DROP AS
SELECT qr.id AS query_run_id, qr.query_id
FROM query_runs qr
JOIN jobs j ON j.id = qr.job_id
WHERE qr.status IN ('SCHEDULED','RUNNING','RETRYING')
  AND j.type = 'SEARCH_YOUTUBE'
  AND j.status = 'FAILED';

UPDATE query_runs qr
SET status = 'FAILED',
    completed_at = COALESCE(qr.completed_at, now()),
    error = COALESCE(qr.error, 'ORPHANED_FAILED_JOB_STATE'),
    performance_details = COALESCE(qr.performance_details, '{}'::jsonb)
      || jsonb_build_object(
        'failureKind', 'ORPHANED_FAILED_JOB_STATE',
        'retryOwnership', 'RELEASED',
        'reconciliationMigration', '122_reconcile_orphaned_query_runs'
      )
WHERE qr.id IN (SELECT query_run_id FROM _orphaned_query_run_reconciliation)
  AND qr.status IN ('SCHEDULED','RUNNING','RETRYING');

UPDATE quota_reservations r
SET status = 'RELEASED'
WHERE r.status = 'RESERVED'
  AND EXISTS (
    SELECT 1
    FROM _orphaned_query_run_reconciliation o
    WHERE (r.operation_type = 'AUTONOMOUS_QUERY_PAGE'
           AND r.operation_id LIKE o.query_run_id::text || ':%')
       OR (r.operation_type = 'SEARCH_YOUTUBE'
           AND r.operation_id = o.query_run_id::text)
  );

UPDATE query_library q
SET reserved_at = NULL,
    reserved_until = NULL,
    reserved_by = NULL
WHERE q.id IN (SELECT query_id FROM _orphaned_query_run_reconciliation)
  AND NOT EXISTS (
    SELECT 1
    FROM query_runs active
    WHERE active.query_id = q.id
      AND active.status IN ('SCHEDULED','RUNNING','RETRYING')
  );

