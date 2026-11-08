export type QueryRunLifecycleStatus = 'SCHEDULED' | 'RUNNING' | 'RETRYING' | 'COMPLETED' | 'FAILED';
export type QueryJobLifecycleStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface QueryRunJobLifecycleInput {
  queryRunStatus: QueryRunLifecycleStatus;
  jobStatus: QueryJobLifecycleStatus;
  jobLastError?: string | null;
  jobRunAfter?: string | null;
  jobCompletedAt?: string | null;
  /** Clock for the completed-job finalization grace window. */
  now?: string | null;
  /** A completed job may still be finalizing its run for this long. */
  completedJobGraceMinutes?: number;
}

export type QueryRunJobLifecycleAction = 'NOOP' | 'ALIGN_RETRY_WAIT' | 'TERMINALIZE_QUERY_RUN';

export interface QueryRunJobLifecycleDecision {
  action: QueryRunJobLifecycleAction;
  queryRunStatus: QueryRunLifecycleStatus;
  releaseReservation: boolean;
  reasonCode: string;
}

const ACTIVE_QUERY_RUNS = new Set<QueryRunLifecycleStatus>(['SCHEDULED', 'RUNNING', 'RETRYING']);

function isActiveQueryRun(status: QueryRunLifecycleStatus): boolean {
  return ACTIVE_QUERY_RUNS.has(status);
}

function hasScheduledRetry(input: QueryRunJobLifecycleInput): boolean {
  return input.jobStatus === 'PENDING'
    && Boolean(input.jobLastError?.trim())
    && Boolean(input.jobRunAfter);
}

/**
 * A retry waiting for execution is represented by the existing durable pair
 * PENDING job + RETRYING query run. That pair retains the query reservation and
 * one execution owner. A FAILED job is terminal from the durable queue's point
 * of view, even if an old error string says that a retry was once intended; its
 * active query run must be closed rather than silently requeued or duplicated.
 */
export function decideQueryRunJobLifecycle(input: QueryRunJobLifecycleInput): QueryRunJobLifecycleDecision {
  if (!isActiveQueryRun(input.queryRunStatus)) {
    return { action: 'NOOP', queryRunStatus: input.queryRunStatus, releaseReservation: false, reasonCode: 'QUERY_RUN_NOT_ACTIVE' };
  }

  if (hasScheduledRetry(input)) {
    return { action: 'ALIGN_RETRY_WAIT', queryRunStatus: 'RETRYING', releaseReservation: false, reasonCode: 'RETRY_WAIT_OWNERSHIP_ALIGNED' };
  }

  if (input.jobStatus === 'FAILED') {
    return { action: 'TERMINALIZE_QUERY_RUN', queryRunStatus: 'FAILED', releaseReservation: true, reasonCode: 'FAILED_JOB_STATUS_IS_TERMINAL' };
  }

  // A COMPLETED job must have finalized its query run. If the run is still
  // active after a bounded grace window, the finalizer was lost (for example
  // the worker crashed between job completion and run completion). Close the
  // orphaned run so its query can be reserved again; the small grace window
  // prevents racing a finalizer that is still committing.
  if (input.jobStatus === 'COMPLETED' && input.jobCompletedAt) {
    const completedAt = Date.parse(input.jobCompletedAt);
    const now = input.now ? Date.parse(input.now) : Date.now();
    const graceMs = Math.max(1, input.completedJobGraceMinutes ?? 15) * 60_000;
    if (Number.isFinite(completedAt) && Number.isFinite(now) && now - completedAt >= graceMs) {
      return { action: 'TERMINALIZE_QUERY_RUN', queryRunStatus: 'FAILED', releaseReservation: true, reasonCode: 'ORPHANED_COMPLETED_JOB_STATE' };
    }
    return { action: 'NOOP', queryRunStatus: input.queryRunStatus, releaseReservation: false, reasonCode: 'COMPLETED_JOB_FINALIZATION_GRACE' };
  }

  return { action: 'NOOP', queryRunStatus: input.queryRunStatus, releaseReservation: false, reasonCode: 'ACTIVE_JOB_OWNS_QUERY_RUN' };
}
