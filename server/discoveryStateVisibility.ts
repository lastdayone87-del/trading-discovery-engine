/**
 * Discovery-state visibility (P3 item 12).
 *
 * The historic dashboard could not distinguish "inspected, cleanly found
 * nothing" from "never had a discovery pass at all" — legacy rows default to
 * NOT_DISCOVERED and look identical to a real negative result. This classifier
 * names the unclassified legacy population `LEGACY_UNCLASSIFIED` so reports
 * and audits can separate the two, without changing any stored state.
 *
 * Scope: pure classification only. The DB-side count lives in dbCore
 * (`countLegacyUnclassifiedChannels`) and uses the same predicate:
 *   NOT_DISCOVERED + NOT_STARTED + no inspection trail + no candidates.
 */
export type DiscoveryVisibilityClass =
  | 'VALIDATED'
  | 'DISCOVERED_VALIDATION_FAILED'
  | 'NOT_DISCOVERED'
  | 'LEGACY_UNCLASSIFIED';

export interface DiscoveryVisibilityInput {
  discordDiscoveryStatus?: string | null;
  discordValidationStatus?: string | null;
  /** True when an inspection trail with at least one step exists. */
  inspectionTrailPresent?: boolean;
  /** Number of candidate rows the channel owns (any status). */
  candidateCount?: number;
}

/** Classifies a channel's discovery state for reporting. A default
 * NOT_DISCOVERED row with no trail and no candidates was never inspected:
 * that is LEGACY_UNCLASSIFIED, not a clean negative. */
export function classifyDiscoveryVisibility(input: DiscoveryVisibilityInput): DiscoveryVisibilityClass {
  const status = String(input.discordDiscoveryStatus || 'NOT_DISCOVERED');
  if (status === 'VALIDATED') return 'VALIDATED';
  if (status === 'DISCOVERED_VALIDATION_FAILED') return 'DISCOVERED_VALIDATION_FAILED';
  const candidates = Number(input.candidateCount || 0);
  const validationStatus = String(input.discordValidationStatus || 'NOT_STARTED');
  if (status === 'NOT_DISCOVERED' && !input.inspectionTrailPresent && candidates === 0 && validationStatus === 'NOT_STARTED') return 'LEGACY_UNCLASSIFIED';
  return 'NOT_DISCOVERED';
}
