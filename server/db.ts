// Public database facade. The long-lived PostgreSQL implementation remains in
// dbCore; retry lifecycle policy is kept here so its clock semantics are explicit
// and independently testable without changing the rest of the database surface.
export * from './dbCore';

import { isOfficialYouTubeQuotaFenceError } from './officialYouTubeQuotaFence';
import { isYouTubePermanentInputError } from './youtubeKeyHealth';
import { getDb, isRetryableInfrastructureFailure, resolveGeminiSemanticCooldownExpiryMs, resolveGeminiOrgSemanticCooldownExpiryMs, resolveGeminiOrgBucketExpiryMs, resolveGroqSemanticCooldownExpiryMs, resolveGroqOrgCooldownExpiryMs, resolveGeminiFreeSemanticCooldownExpiryMs, failedProviderOrg } from './dbCore';
import { acquisitionJobClockV2Enabled, CAPACITY_LEASE_DURATION_MS, capacityLeaseRefreshSetSql, capacityLeaseRunAfter, isCapacityLeaseFailure, normalizeCapacityLeaseRunAfter } from './acquisitionJobClockPolicy';
import { acquisitionEvidenceFromError, classifyAcquisitionFailure, type AcquisitionFailureClassification } from './acquisitionFailureClassification';
import { bumpJobFailureClassification, bumpJobFailureClassificationFallback, bumpJobFailureDisposition, jobDispositionExecutionKey, markJobDispositionCounted, markJobFailureClassificationCounted } from './operationsTelemetry';

export type JobFailureDisposition='RETRYING_WITHOUT_ATTEMPT'|'RETRYING'|'FAILED';

/**
 * Builds the bookkeeping UPDATE that finalizes a failed execution's attempt
 * row. Targets the captured attempt row id (the row open when failJob
 * started): after the job transitions back to PENDING a new worker may claim
 * it and open a newer row, and a job-scoped `finished_at IS NULL` filter
 * would then wrongly finalize the new claim's row with this execution's
 * error. Falls back to the legacy job-scoped filter only when no row was
 * captured (the row is then necessarily this execution's, or already closed).
 */
export function failedAttemptFinalizeQuery(
  jobId: string,
  attemptRowId: unknown,
  error: string,
  classification?: Pick<
    AcquisitionFailureClassification,
    'failureClass' | 'reason' | 'existingCapacityLease' | 'workStartedEvidence'
  >,
): { text: string; values: unknown[] } {
  const captured = attemptRowId !== null && attemptRowId !== undefined && String(attemptRowId) !== '';
  if (classification) {
    // Shadow columns are appended only when the caller has a classification.
    // Flag-off calls with no classification keep the exact legacy statement.
    // existingCapacityLease and workStartedEvidence make disagreements with
    // the legacy predicate and missing evidence measurable after the fact.
    const shadowColumns = 'failure_class=$2,failure_reason=$3,failure_existing_capacity_lease=$4,failure_work_started_evidence=$5';
    const shadowValues = [
      classification.failureClass,
      classification.reason,
      classification.existingCapacityLease,
      classification.workStartedEvidence,
    ];
    if (captured) {
      return {
        text: `UPDATE job_attempts SET status='FAILED',finished_at=now(),error=$1,${shadowColumns} WHERE id=$6 AND finished_at IS NULL`,
        values: [error, ...shadowValues, String(attemptRowId)],
      };
    }
    return {
      text: `UPDATE job_attempts SET status='FAILED',finished_at=now(),error=$1,${shadowColumns} WHERE job_id=$6 AND finished_at IS NULL`,
      values: [error, ...shadowValues, jobId],
    };
  }
  if (captured) {
    return {
      text: `UPDATE job_attempts SET status='FAILED',finished_at=now(),error=$1 WHERE id=$2 AND finished_at IS NULL`,
      values: [error, String(attemptRowId)],
    };
  }
  return {
    text: `UPDATE job_attempts SET status='FAILED',finished_at=now(),error=$1 WHERE job_id=$2 AND finished_at IS NULL`,
    values: [error, jobId],
  };
}

export function parseTransientRetryAgeMs(value:unknown,fallback=6*60*60_000):number{
  const parsed=Number(value);
  return Number.isFinite(parsed)&&parsed>=60_000?parsed:fallback;
}

const MAX_TRANSIENT_RETRY_AGE_MS=parseTransientRetryAgeMs(process.env.MAX_TRANSIENT_RETRY_AGE_MS);

/**
 * Persist only the structured codes the cap monitor needs. Prefixing every
 * string `error.code` would change unrelated persisted messages, including the
 * prefix-anchored `Community acquisition deferred:` recovery patterns.
 */
export const MONITORED_JOB_FAILURE_CODES = new Set([
  'YOUTUBE_KEY_CAP_UNAVAILABLE',
  'QUOTA_ALLOCATION_EXHAUSTED',
]);

/**
 * `executeProviderCall` normalizes a YouTube HTTP quota error into a generic
 * `Provider rate limit reached.` message and keeps `quotaExceeded` /
 * `providerReasons` only as metadata. Add a countable marker for that wrapped
 * shape so provider quota failures still reach the stop rule.
 */
export function persistedJobFailureMessage(error:any):string{
  const message=String(error?.message||error).slice(0,2000);
  const code=typeof error?.code==='string'?error.code.trim():'';
  const providerQuotaSignal=error?.quotaExceeded===true
    || (Array.isArray(error?.providerReasons)
      && error.providerReasons.some((reason:unknown)=>/^(quotaExceeded|dailyLimitExceeded)$/i.test(String(reason))));
  const monitoredCode=MONITORED_JOB_FAILURE_CODES.has(code)
    ? code
    : providerQuotaSignal
      ? 'YOUTUBE_QUOTA_EXCEEDED'
      : '';
  if(!monitoredCode||message.startsWith(`${monitoredCode}:`))return message;
  return `${monitoredCode}: ${message}`.slice(0,2000);
}

export function resolveTransientFailureAnchor(error:any,persistedFirstTransientFailureAt:unknown,now=Date.now()):number{
  if(!isRetryableInfrastructureFailure(error))return now;
  const persisted=persistedFirstTransientFailureAt instanceof Date
    ? persistedFirstTransientFailureAt.getTime()
    : new Date(String(persistedFirstTransientFailureAt||'')).getTime();
  return Number.isFinite(persisted)?persisted:now;
}

export interface JobFailureDb {
  query(text:string,values?:unknown[]):Promise<{rowCount?:number|null;rows:any[]}>;
}

export async function failJob(jobId:string,error:any,deps?:{db?:JobFailureDb;now?:number}):Promise<JobFailureDisposition|null>{
  const db=(deps?.db??await getDb()) as unknown as JobFailureDb;
  const res=await db.query('SELECT attempts,max_attempts,first_transient_failure_at FROM jobs WHERE id=$1',[jobId]);
  if(!res.rowCount)return null;
  const {attempts,max_attempts,first_transient_failure_at}=res.rows[0];
  const now=deps?.now??Date.now();
  const clockV2=acquisitionJobClockV2Enabled();
  // Shadow classification only: it is persisted with the attempt for later
  // comparison and never participates in the transition below. Flag-off keeps
  // the legacy finalize statement and writes no shadow columns. A malformed
  // carrier must not be able to change failure handling, so the shadow is
  // intentionally best-effort here.
  let failureClassification: AcquisitionFailureClassification | undefined;
  if (clockV2) {
    try {
      failureClassification = classifyAcquisitionFailure(error, acquisitionEvidenceFromError(error));
    } catch {
      failureClassification = undefined;
    }
  }
  // Capacity/runtime waits are not genuine acquisition failures. They must not
  // receive a failure-budget anchor, and passing `now` to the decision keeps an
  // old genuine anchor from terminalizing a wait that never ran acquisition.
  const capacityLease=clockV2&&isCapacityLeaseFailure(error);
  const retryableInfrastructure=isRetryableInfrastructureFailure(error);
  const firstFailureAt=capacityLease?now:resolveTransientFailureAnchor(error,first_transient_failure_at,now);
  const msg=persistedJobFailureMessage(error);

  // Query the authoritative Gemini semantic cooldown from provider_call_events.
  // Each account cools independently: when the deferring error carries its
  // route, retry aligns with that account's window; otherwise the pool-wide
  // window applies as before.
  let geminiSemanticCooldownExpiryMs: number|undefined=undefined;
  let groqSemanticCooldownExpiryMs: number|undefined=undefined;
  let geminiFreeSemanticCooldownExpiryMs: number|undefined=undefined;
  const providerReasons=Array.isArray(error?.providerReasons)?error.providerReasons.map(String):[];
  if(providerReasons.includes('SEMANTIC_DEFERRED_RATE_PRESSURE')||providerReasons.includes('GEMINI_CAPACITY_DEFERRED')||(providerReasons.includes('PROVIDER_RATE_LIMIT')&&failedProviderOrg(error,['PROVIDER_RATE_LIMIT'],['gemini_semantic'])!==undefined)){
    const failedGeminiOrg=failedProviderOrg(error,['SEMANTIC_DEFERRED_RATE_PRESSURE','GEMINI_CAPACITY_DEFERRED','PROVIDER_RATE_LIMIT'],['gemini_semantic']);
    geminiSemanticCooldownExpiryMs=failedGeminiOrg?await resolveGeminiOrgSemanticCooldownExpiryMs(failedGeminiOrg,now):await resolveGeminiSemanticCooldownExpiryMs(now);
  }
  // A full per-account token bucket wakes on the moment the oldest counted
  // attempt leaves its rolling window, not a generic backoff. The org survives
  // the enrichment wrapping in `providerFailures[].orgId`.
  if(providerReasons.includes('GEMINI_ORG_TOKEN_BUCKET_EMPTY')){
    const failedGeminiOrg=failedProviderOrg(error,['GEMINI_ORG_TOKEN_BUCKET_EMPTY'],['gemini_semantic']);
    const bucketExpiry=failedGeminiOrg?await resolveGeminiOrgBucketExpiryMs(failedGeminiOrg,now):undefined;
    if(bucketExpiry!==undefined)geminiSemanticCooldownExpiryMs=Math.max(geminiSemanticCooldownExpiryMs??0,bucketExpiry);
  }
  // Groq cooldown from the same persisted ledger (provider='groq'), scoped to
  // the failed organization when the error carries one: a Groq 429 defers the
  // retry past that org's window instead of ticking, and never penalizes
  // healthy orgs. Without an org tag, the pool-wide window applies as before.
  if(providerReasons.includes('GROQ_RATE_LIMITED')){
    const failedGroqOrg=failedProviderOrg(error,['GROQ_RATE_LIMITED']);
    groqSemanticCooldownExpiryMs=failedGroqOrg?await resolveGroqOrgCooldownExpiryMs(failedGroqOrg,now):await resolveGroqSemanticCooldownExpiryMs(now);
  }
  // Free-Gemini pool cooldown from its own persisted ledger
  // (provider='gemini-free'): a free-tier 429 defers the retry past the free
  // pool's shared window instead of ticking. Never touches the paid 'gemini'
  // window above.
  if(providerReasons.includes('GEMINI_FREE_RATE_LIMITED')){
    geminiFreeSemanticCooldownExpiryMs=await resolveGeminiFreeSemanticCooldownExpiryMs(now);
  }

  const decision=(await import('./dbCore')).decideJobFailure(error,attempts,max_attempts,now,firstFailureAt,geminiSemanticCooldownExpiryMs,groqSemanticCooldownExpiryMs,geminiFreeSemanticCooldownExpiryMs);
  // A capacity wait is attempt-free regardless of the generic classification:
  // no acquisition work ran, so it cannot spend a durable attempt or age into
  // a false terminal. The run_after schedule still honors provider hints.
  const disposition:JobFailureDisposition=capacityLease?'RETRYING_WITHOUT_ATTEMPT':decision.disposition;
  const runAfter=capacityLease
    ? normalizeCapacityLeaseRunAfter(error,decision.runAfter??capacityLeaseRunAfter(error,attempts,now),attempts,now)
    : decision.runAfter;
  // Operations telemetry lives on the serving facade (this failJob shadows
  // dbCore.failJob for all worker imports). Capture this execution's open
  // attempt row BEFORE the transition below publishes PENDING: a new claim
  // afterwards would open a newer row, and keying on that would suppress the
  // new claim's own disposition. decideJobFailure itself stays pure
  // (unit-tested without side effects).
  let attemptRowId: unknown = null;
  try {
    const open = await db.query(
      `SELECT id FROM job_attempts WHERE job_id=$1 AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1`,
      [jobId],
    );
    attemptRowId = open.rows[0]?.id ?? null;
  } catch { attemptRowId = null; }
  const executionKey=jobDispositionExecutionKey(attemptRowId, jobId, attempts);
  const countDisposition=()=>{
    if (markJobDispositionCounted(executionKey, disposition)) {
      bumpJobFailureDisposition(disposition);
    }
  };
  const terminalFailureClass = disposition !== 'FAILED' ? null
    : isYouTubePermanentInputError(error) ? 'PERMANENT_INPUT'
      : isOfficialYouTubeQuotaFenceError(error) || String(error?.code || '') === 'INVESTIGATION_DEADLINE_EXCEEDED' ? 'POLICY_TERMINAL'
        : decision.operationallyBlocked ? 'PROVIDER_QUOTA'
          : retryableInfrastructure ? 'RETRYABLE'
            : 'UNKNOWN';
  const persistedMessage=decision.operationallyBlocked&&!capacityLease?`OPERATIONALLY_BLOCKED_RETRY_REQUIRED: ${msg}`:msg;
  const transientAnchor=retryableInfrastructure?new Date(firstFailureAt).toISOString():null;

  if(disposition==='RETRYING_WITHOUT_ATTEMPT'){
    if(capacityLease){
      // Renew only capacity bookkeeping. first_transient_failure_at and
      // created_at are deliberately absent from this statement.
      await db.query(`UPDATE jobs SET status='PENDING',attempts=GREATEST(0,attempts-1),last_error=$2,locked_by=NULL,locked_at=NULL,run_after=$3,terminal_failure_class=NULL,${capacityLeaseRefreshSetSql('$4')} WHERE id=$1`,[jobId,persistedMessage,new Date(runAfter!).toISOString(),String(CAPACITY_LEASE_DURATION_MS)]);
    }else{
      await db.query(`UPDATE jobs SET status='PENDING',attempts=GREATEST(0,attempts-1),last_error=$2,locked_by=NULL,locked_at=NULL,run_after=$3,terminal_failure_class=NULL,first_transient_failure_at=COALESCE(first_transient_failure_at,$4::timestamptz),updated_at=now() WHERE id=$1`,[jobId,persistedMessage,new Date(runAfter!).toISOString(),transientAnchor]);
    }
  }else if(disposition==='FAILED'){
    await db.query(`UPDATE jobs SET status='FAILED',last_error=$2,locked_by=NULL,locked_at=NULL,terminal_failure_class=$5,first_transient_failure_at=CASE WHEN $3::boolean THEN COALESCE(first_transient_failure_at,$4::timestamptz) ELSE first_transient_failure_at END,updated_at=now() WHERE id=$1`,[jobId,persistedMessage,retryableInfrastructure,transientAnchor,terminalFailureClass]);
  }else{
    const seconds=Math.min(900,30*Math.pow(2,Math.max(0,attempts-1)));
    await db.query(`UPDATE jobs SET status='PENDING',last_error=$2,locked_by=NULL,locked_at=NULL,run_after=now()+($3||' seconds')::interval,terminal_failure_class=NULL,first_transient_failure_at=NULL,updated_at=now() WHERE id=$1`,[jobId,persistedMessage,String(seconds)]);
  }
  // The job-row transition above is the disposition: count it here so a
  // failure in the secondary attempts bookkeeping below cannot omit it.

  countDisposition();
  // Finalize THIS execution's captured attempt row by id (never whichever
  // open row happens to exist now — a post-transition claim opens a new row).
  const finalize = failedAttemptFinalizeQuery(jobId, attemptRowId, persistedMessage, failureClassification);
  let classificationPersisted = false;
  try {
    const finalized = await db.query(finalize.text, finalize.values as any[]);
    // Count the shadow only after the durable row exists. A missing attempt
    // row or a concurrent finalizer means no classification is stored, so
    // /api/version must not report one.
    classificationPersisted = failureClassification !== undefined && (finalized.rowCount ?? 0) > 0;
  } catch (finalizeError) {
    if (!failureClassification) throw finalizeError;
    // Shadow evidence must never block the legacy finalize path. This covers
    // a database that has not applied migration 163 yet: the classification
    // write fails atomically, then the unchanged legacy statement finalizes
    // the attempt without the shadow columns.
    console.warn(
      '[JobFailure] Shadow classification write failed; using legacy finalize.',
      finalizeError instanceof Error ? finalizeError.message : finalizeError,
    );
    bumpJobFailureClassificationFallback();
    const legacyFinalize = failedAttemptFinalizeQuery(jobId, attemptRowId, persistedMessage);
    await db.query(legacyFinalize.text, legacyFinalize.values as any[]);
  }
  if (classificationPersisted && failureClassification
    && markJobFailureClassificationCounted(executionKey)) {
    bumpJobFailureClassification(failureClassification.failureClass);
  }
  return disposition;
}
