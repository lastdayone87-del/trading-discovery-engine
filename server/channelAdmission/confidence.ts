/**
 * Semantic admission and downstream classification use a 0–100 percentage.
 * Some providers historically returned `trading_focus` as a 0–1 probability.
 * Normalize legacy fractions before policy thresholds and integer persistence,
 * but only for subjects where trading is an asserted positive focus. Values on
 * UNRELATED/FINANCE_ADJACENT judgments remain low percentages; exactly 1 stays
 * 1 on either side of the boundary so a genuine 1% score is never inflated.
 */
export function normalizeTradingFocus(value: unknown, mainSubject?: string | null): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed)) return 0;
  const positiveSubject = mainSubject === 'TRADING' || mainSubject === 'MIXED';
  const percentage = positiveSubject && parsed > 0 && parsed < 1 ? parsed * 100 : parsed;
  return Math.max(0, Math.min(100, Math.round(percentage)));
}
