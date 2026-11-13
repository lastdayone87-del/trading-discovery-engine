export interface AdmissionOutcomeCounts {
  admitted: number;
  ambiguous: number;
  rejected: number;
  held: number;
  /** Provider/budget waits are infrastructure, not query contamination. */
  deferred?: number;
  /** Genuine ambiguity is a retained outcome, not query contamination. */
  review?: number;
  pending?: number;
  total: number;
}

export interface QueryAdmissionGuardInput {
  pageNumber: number;
  outcomes: AdmissionOutcomeCounts;
  tradingPrecision: number;
  qualityChannels: number;
  tradingConfirmed: number;
  /** Admission-created channels whose downstream classification is still running. */
  classificationPending?: number;
  priorZeroQualityPages?: number;
}

export interface QueryAdmissionGuardDecision {
  stop: boolean;
  quarantine: boolean;
  reasonCodes: string[];
}

/**
 * Admission outcomes feed the query-quality loop. A query that keeps returning
 * channels the gate rejects or holds is contaminated even when those channels
 * are not explicit NON_TRADING. This is the blind spot that let query 711 run
 * to ten pages.
 */
export function evaluateQueryAdmissionGuard(input: QueryAdmissionGuardInput): QueryAdmissionGuardDecision {
  const total = Math.max(0, input.outcomes.total);
  if (input.pageNumber < 2) return { stop: false, quarantine: false, reasonCodes: [] };
  // Do not judge a page while its admission jobs are still queued, but do not
  // let pagination run away before those verdicts exist. Stop this run without
  // quarantining the query; the query remains selectable after the admissions
  // settle.
  if (Number(input.outcomes.pending || 0) > 0) {
    return { stop: true, quarantine: false, reasonCodes: ['ADMISSION_PENDING_WAIT'] };
  }
  if (total < 8) return { stop: false, quarantine: false, reasonCodes: [] };
  const rejectedShare = input.outcomes.rejected / total;
  // Deferred and review outcomes are deliberately retained. They must never
  // stop pagination or quarantine a query merely because AI capacity or a
  // human decision is pending.
  const unresolvedShare = (input.outcomes.rejected + input.outcomes.held) / total;
  const reasonCodes: string[] = [];
  if (rejectedShare >= 0.6) {
    reasonCodes.push('ADMISSION_REJECTED_SHARE_HIGH');
    return { stop: true, quarantine: true, reasonCodes };
  }
  if (unresolvedShare >= 0.5 && input.tradingPrecision < 0.15) {
    reasonCodes.push('ADMISSION_UNRESOLVED_SHARE_HIGH', 'TRADING_PRECISION_LOW');
    // Missing evidence and provider waits are not proof that the query is
    // contaminated. Stop this run, but keep the query selectable.
    return { stop: true, quarantine: false, reasonCodes };
  }
  if (input.qualityChannels === 0
    && input.tradingConfirmed === 0
    && Number(input.classificationPending || 0) === 0
    && (input.priorZeroQualityPages || 0) >= 1) {
    reasonCodes.push('ZERO_QUALITY_AND_ZERO_CONFIRMED_PAGES');
    // Low yield stops this run but is not enough to permanently reject a query.
    return { stop: true, quarantine: false, reasonCodes };
  }
  return { stop: false, quarantine: false, reasonCodes: [] };
}

export function ambiguousAdmitRate(outcomes: AdmissionOutcomeCounts): number {
  const admitted = outcomes.admitted + outcomes.ambiguous;
  return admitted > 0 ? outcomes.ambiguous / admitted : 0;
}

export function ambiguousRateAboveCap(rate: number, cap: number): boolean {
  return rate > cap;
}
