import type {
  ClaimPolarity,
  EvidenceFieldType,
  EvidenceItem,
  NegativeEvidenceRole,
} from './types';

const CREATOR_LEVEL_FIELDS: ReadonlySet<EvidenceFieldType> = new Set<EvidenceFieldType>([
  'channel_bio',
  'transcript_excerpt',
  'pinned_comment',
]);

/**
 * Terminal unrelated-domain evidence needs creator-level attribution. A single
 * video title is an observation, not a creator-wide identity; the collection's
 * terminalNegativeSufficiency gate applies the same rule. Legacy items with no
 * field attribution keep the historical terminal behaviour.
 */
function hasCreatorLevelAttribution(item: EvidenceItem): boolean {
  return hasCreatorLevelAttributionSet([item]);
}

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

export interface NegativeEvidenceRoleOptions {
  /**
   * Collection-level terminal eligibility. Repeated independent video
   * observations can establish creator-level coverage even though each
   * individual item cites one family.
   */
  terminalEligible?: boolean;
}

function isTerminalCandidate(item: EvidenceItem): boolean {
  return item.polarity === 'NEGATIVE'
    && item.category === 'IRRELEVANT_DOMAIN'
    && item.claimPolarity !== 'DISCLAIMER'
    && item.claimPolarity !== 'QUOTED'
    && (!item.claimPolarity || item.claimPolarity === 'ASSERTED');
}

function hasCreatorLevelAttributionSet(items: EvidenceItem[]): boolean {
  const fields = items.flatMap(item => item.provenance?.fields || []);
  if (fields.length === 0) return true; // legacy unattributed negatives
  if (fields.some(field => CREATOR_LEVEL_FIELDS.has(field.field))) return true;
  const families = new Set(
    fields
      .filter(field => field.field === 'video_title' || field.field === 'video_description')
      .map(field => field.sourceFamilyId || field.sourceId)
      .filter((value): value is string => Boolean(value)),
  );
  return families.size >= 2;
}

/** Resolve the policy role of one negative evidence item. */
export function classifyNegativeEvidenceRole(
  item: EvidenceItem,
  options: NegativeEvidenceRoleOptions = {},
): NegativeEvidenceRole {
  if (item.polarity !== 'NEGATIVE') return 'UNKNOWN';
  const { polarity } = suppressedPolarity(item);
  if (polarity === 'DISCLAIMER') return 'DISCLAIMER';
  if (polarity === 'QUOTED') return 'QUOTED';
  if (polarity && polarity !== 'ASSERTED') return 'UNKNOWN';
  if (item.category !== 'IRRELEVANT_DOMAIN') {
    return item.category === 'HYPE_SPECULATION' || item.category === 'NON_TRADING_ADJACENT'
      ? 'CONFIDENCE_PENALTY'
      : 'UNKNOWN';
  }
  if (options.terminalEligible === false) return 'CONFIDENCE_PENALTY';
  if (options.terminalEligible === true) return 'TERMINAL';
  return hasCreatorLevelAttribution(item) ? 'TERMINAL' : 'CONFIDENCE_PENALTY';
}

export function assessNegativeEvidence(
  item: EvidenceItem,
  options: NegativeEvidenceRoleOptions = {},
): NegativeEvidenceAssessment {
  const { polarity, cue } = suppressedPolarity(item);
  return {
    role: classifyNegativeEvidenceRole(item, options),
    category: item.category,
    term: item.provenance?.matchedTerm || item.rawMatches[0] || '',
    field: item.provenance?.fields?.[0]?.field,
    claimPolarity: polarity,
    cue,
  };
}

/** Only terminal unrelated-domain evidence may participate in rejection. */
export function isTerminalNegativeEvidence(
  item: EvidenceItem,
  options: NegativeEvidenceRoleOptions = {},
): boolean {
  return classifyNegativeEvidenceRole(item, options) === 'TERMINAL';
}

export function terminalNegativeItems(
  items: EvidenceItem[],
  options: NegativeEvidenceRoleOptions = {},
): EvidenceItem[] {
  const candidates = items.filter(isTerminalCandidate);
  if (!candidates.length) return [];
  const terminalEligible = options.terminalEligible ?? hasCreatorLevelAttributionSet(candidates);
  if (!terminalEligible) return [];
  return candidates;
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
