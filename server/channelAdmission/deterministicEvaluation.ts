export type EvaluationTruth = 'TRADING_RELEVANT' | 'FINANCE_ADJACENT' | 'UNRELATED' | 'AMBIGUOUS';
export type DeterministicOutcome = 'PASS' | 'REJECT' | 'AMBIGUOUS';

export interface DeterministicCohortCase {
  truth: EvaluationTruth;
  outcome: DeterministicOutcome;
  confidence?: number;
  reasonCodes?: string[];
}

export interface DeterministicCohortSummary {
  total: number;
  outcomes: Record<DeterministicOutcome, number>;
  truth: Record<EvaluationTruth, number>;
  confusion: Record<EvaluationTruth, Record<DeterministicOutcome, number>>;
  confirm: { count: number; trueRelevant: number; falseRelevant: number; hardUnrelated: number; precision: number | null };
  reject: { count: number; trueUnrelated: number; falseUnrelated: number; falseTradingRelevant: number; falseFinanceAdjacent: number; precision: number | null };
  abstain: { count: number; tradingRelevant: number; financeAdjacent: number; unrelated: number };
  reasonCodes: Record<string, number>;
  coverage: { confirmed: number; rejected: number; abstained: number; decisive: number; decisiveRate: number | null };
}

const EMPTY_OUTCOME = (): Record<DeterministicOutcome, number> => ({ PASS: 0, REJECT: 0, AMBIGUOUS: 0 });
const EMPTY_TRUTH = (): Record<EvaluationTruth, number> => ({ TRADING_RELEVANT: 0, FINANCE_ADJACENT: 0, UNRELATED: 0, AMBIGUOUS: 0 });

export function summarizeDeterministicCohort(cases: DeterministicCohortCase[]): DeterministicCohortSummary {
  const outcomes = EMPTY_OUTCOME();
  const truth = EMPTY_TRUTH();
  const confusion: Record<EvaluationTruth, Record<DeterministicOutcome, number>> = {
    TRADING_RELEVANT: EMPTY_OUTCOME(),
    FINANCE_ADJACENT: EMPTY_OUTCOME(),
    UNRELATED: EMPTY_OUTCOME(),
    AMBIGUOUS: EMPTY_OUTCOME(),
  };
  const reasonCodes: Record<string, number> = {};
  for (const item of cases) {
    outcomes[item.outcome] += 1;
    truth[item.truth] += 1;
    confusion[item.truth][item.outcome] += 1;
    for (const code of item.reasonCodes || []) reasonCodes[code] = (reasonCodes[code] || 0) + 1;
  }
  const confirmCount = outcomes.PASS;
  const confirmTrue = confusion.TRADING_RELEVANT.PASS;
  const confirmFalse = confirmCount - confirmTrue;
  const rejectCount = outcomes.REJECT;
  const rejectTrue = confusion.UNRELATED.REJECT;
  const rejectFalse = rejectCount - rejectTrue;
  const decisive = confirmCount + rejectCount;
  return {
    total: cases.length,
    outcomes,
    truth,
    confusion,
    confirm: {
      count: confirmCount,
      trueRelevant: confirmTrue,
      falseRelevant: confirmFalse,
      hardUnrelated: confusion.UNRELATED.PASS,
      precision: confirmCount ? confirmTrue / confirmCount : null,
    },
    reject: {
      count: rejectCount,
      trueUnrelated: rejectTrue,
      falseUnrelated: rejectFalse,
      falseTradingRelevant: confusion.TRADING_RELEVANT.REJECT,
      falseFinanceAdjacent: confusion.FINANCE_ADJACENT.REJECT,
      precision: rejectCount ? rejectTrue / rejectCount : null,
    },
    abstain: {
      count: outcomes.AMBIGUOUS,
      tradingRelevant: confusion.TRADING_RELEVANT.AMBIGUOUS,
      financeAdjacent: confusion.FINANCE_ADJACENT.AMBIGUOUS,
      unrelated: confusion.UNRELATED.AMBIGUOUS,
    },
    reasonCodes: Object.fromEntries(Object.entries(reasonCodes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    coverage: {
      confirmed: confirmCount,
      rejected: rejectCount,
      abstained: outcomes.AMBIGUOUS,
      decisive,
      decisiveRate: cases.length ? decisive / cases.length : null,
    },
  };
}
