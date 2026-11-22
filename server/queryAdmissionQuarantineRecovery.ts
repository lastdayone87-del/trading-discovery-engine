export interface AdmissionQuarantineRecoveryRow {
  id: number;
  query: string;
  country: string;
  status: string;
  collection: string;
  qualityChannelsFound: number;
  uniqueChannelsFound: number;
  timesExecuted: number;
  /** Exact hold selected for review; the apply update must match it. */
  queryHold: unknown;
}

export interface AdmissionQuarantineRecoveryDecision {
  restore: boolean;
  collection: 'PROVEN' | 'EXPERIMENTAL' | null;
  reason: string;
}

/**
 * Admission rejection share is not proof that a query is unusable. Restore a
 * query only when its own historical discovery evidence shows real yield.
 * Queries with no quality or unique discoveries stay rejected for manual
 * review; this script is deliberately not a blanket un-reject.
 */
export function evaluateAdmissionQuarantineRecovery(
  row: Pick<AdmissionQuarantineRecoveryRow, 'qualityChannelsFound' | 'uniqueChannelsFound'>,
): AdmissionQuarantineRecoveryDecision {
  const quality = Math.max(0, Math.trunc(Number(row.qualityChannelsFound) || 0));
  const unique = Math.max(0, Math.trunc(Number(row.uniqueChannelsFound) || 0));
  if (quality <= 0 && unique <= 0) {
    return { restore: false, collection: null, reason: 'NO_HISTORICAL_YIELD' };
  }
  // Restoring a held query must not bypass the normal promotion guard. Put it
  // back into the experimental collection; ordinary promotion evidence can
  // move it to PROVEN later.
  return { restore: true, collection: 'EXPERIMENTAL', reason: 'HISTORICAL_YIELD' };
}
