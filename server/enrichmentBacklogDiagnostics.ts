import { getDb } from './db';
import { diagnoseEnrichmentBacklog } from './enrichmentBacklogDiagnosis';

export const ENRICHMENT_DIAGNOSTIC_QUERIES = {
  aggregate: `
    SELECT
      COUNT(*) FILTER (WHERE status='PENDING')::int AS pending,
      COUNT(*) FILTER (WHERE status='PENDING' AND run_after<=now())::int AS runnable,
      COUNT(*) FILTER (WHERE status='PENDING' AND run_after>now())::int AS deferred,
      COUNT(*) FILTER (WHERE status='PROCESSING')::int AS running,
      COUNT(*) FILTER (WHERE status='FAILED')::int AS failed,
      COUNT(*) FILTER (WHERE status='COMPLETED')::int AS completed,
      MIN(created_at) FILTER (WHERE status IN ('PENDING','PROCESSING')) AS oldest_noncompleted_created_at,
      MIN(run_after) FILTER (WHERE status='PENDING' AND run_after>now()) AS next_deferred_run_at
    FROM jobs
    WHERE type='ENRICH_CHANNEL'
  `,
  throughput: `
    WITH windows(label, minutes) AS (VALUES ('15m',15),('1h',60),('6h',360))
    SELECT
      w.label,
      COUNT(DISTINCT ja.id) FILTER (WHERE ja.started_at>=now()-(w.minutes||' minutes')::interval)::int AS attempts_started,
      COUNT(DISTINCT ja.id) FILTER (WHERE ja.finished_at>=now()-(w.minutes||' minutes')::interval)::int AS attempts_finished,
      COUNT(DISTINCT j.id) FILTER (WHERE j.completed_at>=now()-(w.minutes||' minutes')::interval AND j.status='COMPLETED')::int AS jobs_completed,
      COUNT(DISTINCT j.id) FILTER (WHERE j.updated_at>=now()-(w.minutes||' minutes')::interval AND j.status='FAILED')::int AS jobs_failed_current,
      COUNT(DISTINCT j.id) FILTER (WHERE j.updated_at>=now()-(w.minutes||' minutes')::interval AND j.status='PENDING' AND j.run_after>now())::int AS currently_deferred_recently_updated
    FROM windows w
    CROSS JOIN jobs j
    LEFT JOIN job_attempts ja ON ja.job_id=j.id
    WHERE j.type='ENRICH_CHANNEL'
    GROUP BY w.label,w.minutes
    ORDER BY w.minutes
  `,
  oldest: `
    SELECT
      j.id::text AS job_id,
      j.payload->>'channelId' AS channel_id,
      j.status,
      j.created_at,
      j.updated_at,
      j.run_after,
      j.attempts,
      j.max_attempts,
      j.locked_by,
      j.locked_at,
      LEFT(j.last_error,500) AS last_error,
      (j.status='PENDING' AND j.run_after<=now()) AS runnable,
      i.id::text AS investigation_id,
      i.state AS investigation_state,
      i.deadline_at AS investigation_deadline_at,
      i.current_step_id::text AS investigation_current_step_id,
      s.id::text AS step_id,
      s.state AS step_state,
      s.attempt_count AS step_attempt_count,
      s.failure_class AS step_failure_class,
      s.lease_expires_at AS step_lease_expires_at,
      s.recovery_generation AS step_recovery_generation,
      p.provider AS provider,
      p.operation AS provider_operation,
      p.status AS provider_status,
      p.error_class AS provider_error_class,
      p.occurred_at AS provider_occurred_at,
      p.latency_ms AS provider_latency_ms,
      p.actual_cost AS provider_actual_cost,
      p.reserved_cost AS provider_reserved_cost
    FROM jobs j
    LEFT JOIN investigation_steps s ON s.job_id=j.id
    LEFT JOIN investigations i ON i.id=s.investigation_id
    LEFT JOIN LATERAL (
      SELECT provider,operation,status,error_class,occurred_at,latency_ms,actual_cost,reserved_cost
      FROM provider_call_events
      WHERE job_id=j.id::text
      ORDER BY occurred_at DESC
      LIMIT 1
    ) p ON true
    WHERE j.type='ENRICH_CHANNEL' AND j.status IN ('PENDING','PROCESSING')
    ORDER BY j.created_at ASC,j.id ASC
    LIMIT $1
  `
} as const;

export async function getEnrichmentBacklogDiagnostics(requestedLimit=10):Promise<any>{
  const limit=Math.min(Math.max(Number.isFinite(requestedLimit)?Math.trunc(requestedLimit):10,1),50);
  const db=await getDb();
  const [aggregate,throughput,oldest]=await Promise.all([
    db.query(ENRICHMENT_DIAGNOSTIC_QUERIES.aggregate),
    db.query(ENRICHMENT_DIAGNOSTIC_QUERIES.throughput),
    db.query(ENRICHMENT_DIAGNOSTIC_QUERIES.oldest,[limit])
  ]);
  const now=Date.now();
  const jobs=oldest.rows.map((row:any)=>({
    jobId:row.job_id,
    channelId:row.channel_id||null,
    status:row.status,
    createdAt:row.created_at,
    updatedAt:row.updated_at,
    runAfter:row.run_after,
    attempts:Number(row.attempts||0),
    maxAttempts:Number(row.max_attempts||0),
    lockedBy:row.locked_by||null,
    lockedAt:row.locked_at||null,
    lastError:row.last_error||null,
    runnable:Boolean(row.runnable),
    investigation:row.investigation_id?{
      id:row.investigation_id,
      state:row.investigation_state,
      deadlineAt:row.investigation_deadline_at,
      currentStepId:row.investigation_current_step_id,
      step:{
        id:row.step_id,
        state:row.step_state,
        attemptCount:Number(row.step_attempt_count||0),
        failureClass:row.step_failure_class||null,
        leaseExpiresAt:row.step_lease_expires_at,
        recoveryGeneration:Number(row.step_recovery_generation||0)
      }
    }:null,
    provider:row.provider?{
      provider:row.provider,
      operation:row.provider_operation,
      status:row.provider_status,
      errorClass:row.provider_error_class||null,
      occurredAt:row.provider_occurred_at,
      latencyMs:Number(row.provider_latency_ms||0),
      actualCost:Number(row.provider_actual_cost||0),
      reservedCost:Number(row.provider_reserved_cost||0)
    }:null,
    diagnosis:diagnoseEnrichmentBacklog({
      status:row.status,
      runAfter:new Date(row.run_after).toISOString(),
      runnable:Boolean(row.runnable),
      lockedBy:row.locked_by,
      lockedAt:row.locked_at,
      investigationState:row.investigation_state,
      investigationDeadlineAt:row.investigation_deadline_at?new Date(row.investigation_deadline_at).toISOString():null,
      stepState:row.step_state,
      failureClass:row.step_failure_class||row.provider_error_class,
      lastError:row.last_error
    },now)
  }));
  return {
    generatedAt:new Date(now).toISOString(),
    readOnly:true,
    limit,
    aggregate:aggregate.rows[0]||{},
    throughput:throughput.rows,
    oldest:jobs
  };
}
