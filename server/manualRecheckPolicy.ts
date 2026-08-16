export interface DegradedManualClassificationInput {
  existingTradingStatus?: string | null;
  errorCode?: string | null;
}

/**
 * Manual community inspection may continue without a fresh semantic trading
 * decision only when an earlier trusted decision already says the creator is
 * trading and the current failure is specifically incomplete classifier
 * coverage. This is deliberately not a general provider-failure bypass.
 */
export function canContinueCommunityInspectionAfterDegradedManualClassification(
  input: DegradedManualClassificationInput
): boolean {
  return input.existingTradingStatus === 'TRADING_CONFIRMED'
    && input.errorCode === 'MANUAL_RESCAN_CLASSIFICATION_DEGRADED';
}
