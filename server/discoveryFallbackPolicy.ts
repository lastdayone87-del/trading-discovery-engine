/**
 * A fail-closed exhausted portfolio with no free provider cannot be fixed by
 * generating another targeted candidate. This skips only targeted generation;
 * the caller must still run the normal whole-pool selector.
 */
export function shouldSkipTargetedGeneration(reasonCodes: readonly string[] | null | undefined): boolean {
  if (!reasonCodes) return false;
  return reasonCodes.includes('PORTFOLIO_BUDGET_EXHAUSTED')
    && reasonCodes.includes('NO_QUOTA_FREE_PROVIDER');
}
