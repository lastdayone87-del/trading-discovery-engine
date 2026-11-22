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
  /** Fresh confirmed creators found on this page/run. */
  freshConfirmedCreators?: number;
  /** The normal continuation policy already considers this page productive. */
  productiveContinuation?: boolean;
  /** Live run-wide yield from the current channel state. */
  runQualityChannels?: number;
  runTradingConfirmed?: number;
  /** Classifications still pending in this run; rejection must wait. */
  runClassificationPending?: number;
  /** True only when run-wide yield evidence loaded successfully. */
  runYieldAvailable?: boolean;
  /** Admission-created channels whose downstream classification is still running. */
  classificationPending?: number;
  priorZeroQualityPages?: number;
  /** Query-level history used only for the separate quarantine decision. */
  priorQueryRuns?: number;
  priorQueryQualityChannels?: number;
  priorQueryUniqueChannels?: number;
}

export interface QueryAdmissionGuardDecision {
  stop: boolean;
  /**
   * A provisional stop while admission verdicts are still pending. The run
   * must be deferred and resumed after the admissions settle; it must never be
   * recorded as a terminal page stop or a query quarantine.
   */
  defer?: boolean;
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
  // Do not judge a page while its admission jobs are still queued. This is a
  // provisional deferral, not a terminal stop: the verdicts may turn the page
  // into a productive one. The caller must defer the run and resume it after
  // the admissions settle, without quarantining the query.
  if (Number(input.outcomes.pending || 0) > 0) {
    return { stop: true, defer: true, quarantine: false, reasonCodes: ['ADMISSION_PENDING_WAIT'] };
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
    // Rejection share is measured over uncertain admission candidates only.
    // A page/run that still produced confirmed, quality or fresh creators —
    // or that the normal policy already marks productive — must not be
    // overridden by that subset.
    const productivePage = input.qualityChannels > 0
      || input.tradingConfirmed > 0
      || Number(input.freshConfirmedCreators || 0) > 0
      || input.productiveContinuation === true;
    if (productivePage) return { stop: false, quarantine: false, reasonCodes };
    // Run stop is separate from query rejection. Earlier pages of this run may
    // already have produced quality/confirmed creators even though the query
    // stats are only updated when the run completes; such a run is productive
    // and must never be rejected from one later bad page.
    const productiveRun = Number(input.runQualityChannels || 0) > 0
      || Number(input.runTradingConfirmed || 0) > 0;
    // Permanent rejection requires successfully loaded, settled run evidence.
    // A transient metrics failure or a pending classification must never be
    // read as zero yield.
    const runEvidenceSettled = input.runYieldAvailable === true
      && Number(input.runClassificationPending || 0) === 0;
    const queryEvidenceSufficient = runEvidenceSettled
      && !productiveRun
      && Number(input.priorQueryRuns || 0) >= 2
      && Number(input.priorQueryQualityChannels || 0) === 0
      && Number(input.priorQueryUniqueChannels || 0) === 0;
    return { stop: true, quarantine: queryEvidenceSufficient, reasonCodes };
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
