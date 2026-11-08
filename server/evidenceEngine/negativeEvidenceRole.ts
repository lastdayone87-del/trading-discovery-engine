import type {
  ClaimPolarity,
  EvidenceFieldType,
  EvidenceItem,
  NegativeEvidenceRole,
} from './types';

/**
 * Negative evidence roles.
 *
 * The system historically treated every negative item as potential terminal
 * opposition. A hype disclaimer, a quoted criticism and an asserted speculation
 * claim are not the same thing, and only creator-level unrelated-domain
 * evidence may reject. Roles make that distinction explicit before staged
 * classification and the unified policy run.
 */
export const NEGATIVE_EVIDENCE_ROLE_VERSION = 'negative-evidence-role-v1';

export interface NegativeEvidenceAssessment {
  role: NegativeEvidenceRole;
  category: string;
  term: string;
  field?: EvidenceFieldType;
  claimPolarity?: ClaimPolarity;
  cue?: string;
}

function suppressedPolarity(item: EvidenceItem): { polarity?: ClaimPolarity; cue?: string } {
  if (item.claimPolarity) return { polarity: item.claimPolarity };
  const suppressed = item.provenance?.suppressedMatches?.[0];
  return suppressed ? { polarity: suppressed.polarity, cue: suppressed.cue } : {};
}

/** Resolve the policy role of one negative evidence item. */
export function classifyNegativeEvidenceRole(item: EvidenceItem): NegativeEvidenceRole {
  if (item.polarity !== 'NEGATIVE') return 'UNKNOWN';
  const { polarity } = suppressedPolarity(item);
  if (polarity === 'DISCLAIMER') return 'DISCLAIMER';
  if (polarity === 'QUOTED') return 'QUOTED';
  if (polarity && polarity !== 'ASSERTED') return 'UNKNOWN';
  switch (item.category) {
    case 'IRRELEVANT_DOMAIN':
      return 'TERMINAL';
    case 'HYPE_SPECULATION':
    case 'NON_TRADING_ADJACENT':
      return 'CONFIDENCE_PENALTY';
    default:
      return 'UNKNOWN';
  }
}

export function assessNegativeEvidence(item: EvidenceItem): NegativeEvidenceAssessment {
  const { polarity, cue } = suppressedPolarity(item);
  return {
    role: classifyNegativeEvidenceRole(item),
    category: item.category,
    term: item.provenance?.matchedTerm || item.rawMatches[0] || '',
    field: item.provenance?.fields?.[0]?.field,
    claimPolarity: polarity,
    cue,
  };
}

/** Only terminal unrelated-domain evidence may participate in rejection. */
export function isTerminalNegativeEvidence(item: EvidenceItem): boolean {
  return classifyNegativeEvidenceRole(item) === 'TERMINAL';
}

export function terminalNegativeItems(items: EvidenceItem[]): EvidenceItem[] {
  return items.filter(isTerminalNegativeEvidence);
}

export function penaltyOnlyNegativeItems(items: EvidenceItem[]): EvidenceItem[] {
  return items.filter(item => classifyNegativeEvidenceRole(item) === 'CONFIDENCE_PENALTY');
}

/**
 * Effective negative weight under the role policy. Disclaimers, quotations and
 * ambiguous-scope negatives are absence, not opposition, so they contribute
 * zero even if a legacy fixture or provider emitted them as negative items.
 */
export function negativeEvidencePolicyWeight(item: EvidenceItem): number {
  const role = classifyNegativeEvidenceRole(item);
  if (role === 'DISCLAIMER' || role === 'QUOTED' || role === 'UNKNOWN') return 0;
  return Math.abs(item.finalWeight);
}

export function policyNegativeItems(items: EvidenceItem[]): EvidenceItem[] {
  return items.filter(item => negativeEvidencePolicyWeight(item) > 0);
}
