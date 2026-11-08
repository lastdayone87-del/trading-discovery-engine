import type { EvidenceFieldRef, EvidenceFieldType, LayeredKnowledgeContext, RawChannelInput } from './types';
import { creatorOwnedEvidenceCorpus } from './canonicalEvidencePlane';
import {
  assessTradingText,
  hasExplicitAlternativeIdentity,
  type CompositionTextFocus,
  type TradingSignalMatch,
} from './tradingSignalTaxonomy';

export {
  FINANCIAL_CONTEXT_CJK_PATTERN,
  FINANCIAL_CONTEXT_PATTERN,
  TRADING_SIGNAL_TAXONOMY_VERSION,
  affirmedTierATradingSignals,
  assessTradingText,
  classifyCompositionDocument,
  hasExplicitAlternativeIdentity,
  isAffirmativeTradingText,
  isCompositionTradingText,
  isTierATradingText,
  isUninformativeText,
  matchTradingSignals,
  tierATradingSignals,
} from './tradingSignalTaxonomy';
export type {
  CompositionTextFocus,
  TradingSignalCategory,
  TradingSignalMatch,
  TradingSignalStrength,
  TradingTextAssessment,
} from './tradingSignalTaxonomy';

/**
 * C5 contextual composition v2.
 *
 * A creator is not a bag of additive term weights. This module classifies each
 * creator-owned document on its own text with the shared trading-signal
 * taxonomy, collapses fields that share one underlying item into a family,
 * collapses duplicate uploads, and asks whether the observed output is
 * coherently trading. The channel title is retained only as a name prior; it
 * is never an observed family or the required non-title Tier A dimension.
 *
 * v2 separates:
 * - TRADING_CORE: execution, setups, journal, risk, live trading, creator identity.
 * - TRADING_ADJACENT: instrument-specific commentary and trading education.
 * - FINANCE_ADJACENT: personal finance, investing, business news, hype.
 * - UNRELATED: music, gaming, cooking, sports, film/TV, lifestyle, cards.
 * - UNINFORMATIVE: duplicates, links, boilerplate, unknown text.
 *
 * `search_match_context` is retrieval provenance and is excluded entirely.
 */
export const CONTEXTUAL_COMPOSITION_VERSION = 'contextual-composition-v2';

export type CreatorFocus =
  | 'TRADING_DOMINANT'
  | 'ALTERNATIVE_DOMINANT'
  | 'MIXED'
  | 'INSUFFICIENT_COVERAGE'
  | 'QUERY_ONLY';

/** `TRADING` is retained as a compatibility alias for `TRADING_CORE`. */
export type CompositionDocumentFocus = CompositionTextFocus;
export type LegacyCompositionDocumentFocus = 'TRADING' | 'ALTERNATIVE' | 'NEUTRAL';

export interface CompositionDocument {
  field: EvidenceFieldType;
  text: string;
  sourceFamilyId: string;
  publishedAt?: string;
}

export interface CompositionFamilyClassification {
  sourceFamilyId: string;
  field: EvidenceFieldType;
  focus: CompositionDocumentFocus;
  recent: boolean;
  tierA: boolean;
  /** Group identifier shared by collapsed duplicate families. */
  duplicateGroupId?: string;
  /** Signals that were asserted in this family's documents. */
  signals?: TradingSignalMatch[];
  /** Disclaimers, quotations and negations suppressed from classification. */
  suppressedSignals?: TradingSignalMatch[];
}

export interface ContextualCompositionReport {
  version: string;
  focus: CreatorFocus;
  /** Raw family count before duplicate collapse. Kept for diagnostics. */
  observedFamilies: number;
  /** Non-UNINFORMATIVE families: the v2 coverage denominator. */
  informativeFamilies: number;
  duplicateFamiliesCollapsed: number;
  tradingFamilies: number;
  tradingCoreFamilies: number;
  tradingAdjacentFamilies: number;
  financeAdjacentFamilies: number;
  unrelatedFamilies: number;
  uninformativeFamilies: number;
  /** Finance-adjacent + unrelated families. */
  alternativeFamilies: number;
  /** Uninformative families (absence, not opposition). */
  neutralFamilies: number;
  recentTradingFamilies: number;
  recentAlternativeFamilies: number;
  tradingCoverage: number;
  /** Finance-adjacent + unrelated coverage. Keeps the <0.34 guard protective. */
  alternativeCoverage: number;
  financeCoverage: number;
  unrelatedCoverage: number;
  temporalCoverage: 'KNOWN' | 'UNKNOWN';
  nonTitleTierAFamilies: number;
  explicitCreatorTrading: boolean;
  explicitCreatorAlternative: boolean;
  namePriorTrading: boolean;
  familyClassifications: CompositionFamilyClassification[];
  reasonCodes: string[];
}

/**
 * Fields that can form a composition family. Registry metadata (country,
 * language, activity) is contextual, not creator output, and cannot make a
 * retrieval-only observation look like an observed family.
 */
const COMPOSITION_FIELDS: ReadonlySet<EvidenceFieldType> = new Set<EvidenceFieldType>([
  'channel_title',
  'channel_bio',
  'video_title',
  'video_description',
  'playlist_name',
  'playlist_description',
  'external_link_label',
  'external_link_domain',
  'transcript_excerpt',
  'visual_evidence',
  'discord_invite',
  'pinned_comment',
]);

const CREATOR_LEVEL_FIELDS: ReadonlySet<EvidenceFieldType> = new Set<EvidenceFieldType>([
  'channel_bio',
  'transcript_excerpt',
  'pinned_comment',
]);

const FOCUS_RANK: Record<CompositionDocumentFocus, number> = {
  UNINFORMATIVE: 0,
  UNRELATED: 1,
  FINANCE_ADJACENT: 2,
  TRADING_ADJACENT: 3,
  TRADING_CORE: 4,
};

const TRADING_FOCUSES: ReadonlySet<CompositionDocumentFocus> = new Set([
  'TRADING_CORE',
  'TRADING_ADJACENT',
]);

const ALTERNATIVE_FOCUSES: ReadonlySet<CompositionDocumentFocus> = new Set([
  'FINANCE_ADJACENT',
  'UNRELATED',
]);

export function creatorOwnedDocuments(input: RawChannelInput): CompositionDocument[] {
  // Use the canonical creator-owned view so retrieval provenance
  // (`search_match_context`) can never become a composition family.
  return creatorOwnedEvidenceCorpus(input)
    .filter(document => COMPOSITION_FIELDS.has(document.field))
    .map(document => ({
      field: document.field,
      text: document.text,
      sourceFamilyId: document.sourceFamilyId,
      publishedAt: document.publishedAt,
    }));
}

/**
 * Strict ISO-calendar timestamp. `Date.parse` normalizes impossible dates
 * (`2024-02-31` becomes March 2), so presence alone cannot prove temporal
 * coverage. Only a real YYYY-MM-DD day in an ISO-shaped value counts.
 */
function publishedTimestamp(publishedAt: string | undefined): number | undefined {
  if (!publishedAt) return undefined;
  const value = String(publishedAt).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return undefined;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isRecent(publishedAt: string | undefined, now: Date): boolean {
  const timestamp = publishedTimestamp(publishedAt);
  if (timestamp === undefined) return false;
  const ageMs = now.getTime() - timestamp;
  // A future-dated document is not "recent published evidence": clamp the age
  // to zero so it cannot create a false recency conflict reason.
  return ageMs >= 0 && ageMs <= 365 * 86_400_000;
}

function normalizedForComparison(text: string): string {
  return String(text || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/https?:\/\/\S+/gu, ' ')
    .replace(/\b(?:www\.)?[\w-]+(?:\.[\w-]+)+(?:\/\S*)?/gu, ' ')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function tokenSet(normalized: string): Set<string> {
  // Keep numeric tokens: `Day trading setup 1` and `Day trading setup 2` are
  // distinct videos, not a duplicate upload.
  return new Set(normalized.split(' ').filter(Boolean));
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection++;
  return intersection / (left.size + right.size - intersection);
}

/**
 * Episode/part numbers distinguish uploads even when long titles share almost
 * every token. Near-duplicate collapse must not overwrite that distinction.
 */
function numericSignature(tokens: Set<string>): string {
  return [...tokens].filter(token => /^\d+$/u.test(token)).sort().join(',');
}

function strongestFocus(focuses: CompositionDocumentFocus[]): CompositionDocumentFocus {
  return focuses.reduce((strongest, focus) => FOCUS_RANK[focus] > FOCUS_RANK[strongest] ? focus : strongest, 'UNINFORMATIVE');
}

function uniqueSignals(signals: TradingSignalMatch[]): TradingSignalMatch[] {
  const seen = new Set<string>();
  return signals.filter(signal => {
    const key = `${signal.id}:${signal.start}:${signal.end}:${signal.term.toLocaleLowerCase('en')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface FamilyRecord {
  sourceFamilyId: string;
  field: EvidenceFieldType;
  normalized: string;
  tokens: Set<string>;
  recent: boolean;
  tierA: boolean;
  focus: CompositionDocumentFocus;
  signals: TradingSignalMatch[];
  suppressedSignals: TradingSignalMatch[];
  explicitCreatorTrading: boolean;
  explicitCreatorAlternative: boolean;
  duplicateGroupId: string;
}

interface DuplicateGroup {
  records: FamilyRecord[];
  sourceFamilyId: string;
  field: EvidenceFieldType;
  normalized: string;
  tokens: Set<string>;
  recent: boolean;
  tierA: boolean;
  focus: CompositionDocumentFocus;
  signals: TradingSignalMatch[];
  suppressedSignals: TradingSignalMatch[];
  explicitCreatorTrading: boolean;
  explicitCreatorAlternative: boolean;
  duplicateGroupId: string;
}

function mergeIntoGroup(group: DuplicateGroup, record: FamilyRecord): void {
  record.duplicateGroupId = group.duplicateGroupId;
  group.records.push(record);
  group.recent = group.recent || record.recent;
  group.tierA = group.tierA || record.tierA;
  group.explicitCreatorTrading = group.explicitCreatorTrading || record.explicitCreatorTrading;
  group.explicitCreatorAlternative = group.explicitCreatorAlternative || record.explicitCreatorAlternative;
  group.signals.push(...record.signals);
  group.suppressedSignals.push(...record.suppressedSignals);
  if (FOCUS_RANK[record.focus] > FOCUS_RANK[group.focus]) {
    group.focus = record.focus;
    group.field = record.field;
    group.normalized = record.normalized;
    group.tokens = record.tokens;
    group.sourceFamilyId = record.sourceFamilyId;
  }
}

/**
 * Build the C5 composition from the creator-owned corpus. The title is a name
 * prior only; families are counted from bio, videos, playlists, links,
 * transcripts, pinned comments and visual evidence.
 */
export function buildContextualComposition(
  input: RawChannelInput,
  context?: LayeredKnowledgeContext,
  now = new Date(),
): ContextualCompositionReport {
  const documents = creatorOwnedDocuments(input).filter(document => document.field !== 'channel_title');
  const titleDocument = (input.evidence_corpus || []).find(document => document.field === 'channel_title');
  const namePriorAssessment = assessTradingText(titleDocument?.text || input.channel_name || '', context);
  const namePriorTrading = TRADING_FOCUSES.has(namePriorAssessment.focus);

  // Collapse multiple fields of one underlying item into one family. Canonical
  // documents already carry the source family; legacy fixtures fall back to a
  // stable field/index key.
  const byFamily = new Map<string, CompositionDocument[]>();
  documents.forEach((document, index) => {
    const key = document.sourceFamilyId || `${document.field}:${index}`;
    byFamily.set(key, [...(byFamily.get(key) || []), document]);
  });

  // Presence is not knowledge: a non-empty but unparseable timestamp would
  // otherwise mark temporal coverage KNOWN and skip the missing-evidence gap.
  const temporalKnown = documents.some(document =>
    typeof document.publishedAt === 'string' && publishedTimestamp(document.publishedAt) !== undefined
  );

  const records: FamilyRecord[] = [];
  for (const [sourceFamilyId, familyDocuments] of byFamily) {
    const assessments = familyDocuments.map(document => ({
      document,
      assessment: assessTradingText(document.text, context, document.field),
    }));
    const focus = strongestFocus(assessments.map(item => item.assessment.focus));
    const representative = assessments
      .slice()
      .sort((left, right) => FOCUS_RANK[right.assessment.focus] - FOCUS_RANK[left.assessment.focus])[0];
    const signals = uniqueSignals(assessments.flatMap(item => item.assessment.assertedSignals));
    const suppressedSignals = uniqueSignals(assessments.flatMap(item => item.assessment.suppressedSignals));
    const tierA = assessments.some(item =>
      item.assessment.tierASignals.length > 0
      && TRADING_FOCUSES.has(item.assessment.focus)
    );
    const creatorTrading = assessments.some(item =>
      CREATOR_LEVEL_FIELDS.has(item.document.field)
      && TRADING_FOCUSES.has(item.assessment.focus)
      && item.assessment.tierASignals.length > 0
    );
    const creatorAlternative = assessments.some(item =>
      CREATOR_LEVEL_FIELDS.has(item.document.field)
      && (item.assessment.focus === 'UNRELATED' || hasExplicitAlternativeIdentity(item.document.text))
    );
    // Duplicate checks compare the whole upload (title + description + other
    // fields), not one representative field. Two videos with the same generic
    // title but materially different descriptions are distinct families.
    const normalized = normalizedForComparison(familyDocuments.map(document => document.text).join('\n'));
    records.push({
      sourceFamilyId,
      field: representative?.document.field || familyDocuments[0].field,
      normalized,
      tokens: tokenSet(normalized),
      recent: familyDocuments.some(document => isRecent(document.publishedAt, now)),
      tierA,
      focus,
      signals,
      suppressedSignals,
      explicitCreatorTrading: creatorTrading,
      explicitCreatorAlternative: creatorAlternative,
      duplicateGroupId: '',
    });
  }

  // Collapse exact and conservative near-duplicates. Independent uploads that
  // repeat one generic title ("Another Day") are one observed family; two
  // distinct videos with materially different descriptions are not.
  const groups: DuplicateGroup[] = [];
  const byExactContent = new Map<string, DuplicateGroup>();
  for (const record of records) {
    let group = record.normalized ? byExactContent.get(record.normalized) : undefined;
    if (!group && record.normalized && record.tokens.size >= 3) {
      for (const candidate of groups) {
        if (candidate.field !== record.field || !candidate.normalized) continue;
        if (jaccard(record.tokens, candidate.tokens) >= 0.9
          && numericSignature(record.tokens) === numericSignature(candidate.tokens)) {
          group = candidate;
          break;
        }
      }
    }
    if (group) {
      mergeIntoGroup(group, record);
      if (record.normalized) byExactContent.set(record.normalized, group);
      continue;
    }
    const duplicateGroupId = `composition-family:${groups.length}`;
    record.duplicateGroupId = duplicateGroupId;
    const created: DuplicateGroup = {
      records: [record],
      sourceFamilyId: record.sourceFamilyId,
      field: record.field,
      normalized: record.normalized,
      tokens: record.tokens,
      recent: record.recent,
      tierA: record.tierA,
      focus: record.focus,
      signals: [...record.signals],
      suppressedSignals: [...record.suppressedSignals],
      explicitCreatorTrading: record.explicitCreatorTrading,
      explicitCreatorAlternative: record.explicitCreatorAlternative,
      duplicateGroupId,
    };
    groups.push(created);
    if (record.normalized) byExactContent.set(record.normalized, created);
  }

  let tradingCoreFamilies = 0;
  let tradingAdjacentFamilies = 0;
  let financeAdjacentFamilies = 0;
  let unrelatedFamilies = 0;
  let uninformativeFamilies = 0;
  let recentTradingFamilies = 0;
  let recentAlternativeFamilies = 0;
  let nonTitleTierAFamilies = 0;
  let explicitCreatorTrading = false;
  let explicitCreatorAlternative = false;

  for (const group of groups) {
    switch (group.focus) {
      case 'TRADING_CORE': tradingCoreFamilies++; break;
      case 'TRADING_ADJACENT': tradingAdjacentFamilies++; break;
      case 'FINANCE_ADJACENT': financeAdjacentFamilies++; break;
      case 'UNRELATED': unrelatedFamilies++; break;
      default: uninformativeFamilies++; break;
    }
    if (TRADING_FOCUSES.has(group.focus)) {
      if (group.recent) recentTradingFamilies++;
      if (group.tierA) nonTitleTierAFamilies++;
    }
    if (ALTERNATIVE_FOCUSES.has(group.focus) && group.recent) recentAlternativeFamilies++;
    if (group.explicitCreatorTrading) explicitCreatorTrading = true;
    if (group.explicitCreatorAlternative) explicitCreatorAlternative = true;
  }

  const tradingFamilies = tradingCoreFamilies + tradingAdjacentFamilies;
  const alternativeFamilies = financeAdjacentFamilies + unrelatedFamilies;
  const informativeFamilies = tradingFamilies + alternativeFamilies;
  const denominator = informativeFamilies;
  const tradingCoverage = denominator ? tradingFamilies / denominator : 0;
  const financeCoverage = denominator ? financeAdjacentFamilies / denominator : 0;
  const unrelatedCoverage = denominator ? unrelatedFamilies / denominator : 0;
  const alternativeCoverage = denominator ? alternativeFamilies / denominator : 0;

  const reasons: string[] = [];
  let focus: CreatorFocus;

  if (groups.length === 0) {
    // Retrieval provenance with no observed creator-owned family is QUERY_ONLY,
    // even when a channel title exists: the title is a name prior, not an
    // observed family, and cannot turn a search hit into creator evidence.
    focus = input.search_match_context ? 'QUERY_ONLY' : 'INSUFFICIENT_COVERAGE';
    reasons.push(input.search_match_context ? 'NO_CREATOR_OWNED_OBSERVED_FAMILY' : 'INSUFFICIENT_INDEPENDENT_TRADING_COVERAGE');
  } else if (explicitCreatorTrading
    && !explicitCreatorAlternative
    && nonTitleTierAFamilies >= 1
    && alternativeCoverage < 0.34
    && unrelatedCoverage < 0.34) {
    focus = 'TRADING_DOMINANT';
    reasons.push('EXPLICIT_CREATOR_TRADING_STATEMENT');
  } else if (tradingCoreFamilies >= 2
    && tradingCoverage >= 0.5
    && alternativeCoverage < 0.34
    && unrelatedCoverage < 0.34) {
    focus = 'TRADING_DOMINANT';
    reasons.push('TRADING_COVERAGE_DOMINANT');
  } else if (explicitCreatorAlternative && !explicitCreatorTrading) {
    focus = 'ALTERNATIVE_DOMINANT';
    reasons.push('EXPLICIT_CREATOR_ALTERNATIVE_STATEMENT');
  } else if (alternativeFamilies >= 2 && alternativeCoverage >= 0.6 && tradingCoverage <= 0.2) {
    focus = 'ALTERNATIVE_DOMINANT';
    reasons.push('ALTERNATIVE_COVERAGE_DOMINANT');
  } else if (recentAlternativeFamilies > recentTradingFamilies && alternativeFamilies > 0 && tradingFamilies > 0) {
    // Must precede the generic mixed branch: both families exist, but the
    // recency signal is the more specific explanation and should be retained.
    focus = 'MIXED';
    reasons.push('RECENT_ALTERNATIVE_OUTPUT_CONFLICTS_WITH_TRADING_HISTORY');
  } else if (tradingFamilies > 0 && alternativeFamilies > 0) {
    focus = 'MIXED';
    reasons.push('TRADING_AND_ALTERNATIVE_CONFLICT');
  } else {
    focus = 'INSUFFICIENT_COVERAGE';
    reasons.push('INSUFFICIENT_INDEPENDENT_TRADING_COVERAGE');
  }

  if (explicitCreatorTrading && explicitCreatorAlternative) {
    focus = 'MIXED';
    reasons.push('EXPLICIT_CREATOR_STATEMENTS_CONFLICT');
  }

  const familyClassifications: CompositionFamilyClassification[] = records.map(record => ({
    sourceFamilyId: record.sourceFamilyId,
    field: record.field,
    focus: record.focus,
    recent: record.recent,
    tierA: record.tierA,
    duplicateGroupId: record.duplicateGroupId,
    signals: record.signals,
    suppressedSignals: record.suppressedSignals,
  }));

  return {
    version: CONTEXTUAL_COMPOSITION_VERSION,
    focus,
    observedFamilies: records.length,
    informativeFamilies,
    duplicateFamiliesCollapsed: records.length - groups.length,
    tradingFamilies,
    tradingCoreFamilies,
    tradingAdjacentFamilies,
    financeAdjacentFamilies,
    unrelatedFamilies,
    uninformativeFamilies,
    alternativeFamilies,
    neutralFamilies: uninformativeFamilies,
    recentTradingFamilies,
    recentAlternativeFamilies,
    tradingCoverage,
    alternativeCoverage,
    financeCoverage,
    unrelatedCoverage,
    temporalCoverage: temporalKnown ? 'KNOWN' : 'UNKNOWN',
    nonTitleTierAFamilies,
    explicitCreatorTrading,
    explicitCreatorAlternative,
    namePriorTrading,
    familyClassifications,
    reasonCodes: reasons,
  };
}

/** Provenance-aware replacement for the old input-shape hydration guard. */
export function isThinRetrievalComposition(input: RawChannelInput, composition: ContextualCompositionReport): boolean {
  if (Number(input.enrichment_stage || 0) !== 0) return false;
  if (composition.focus === 'QUERY_ONLY') return true;
  // Abstain from terminal rejection only when the negative evidence is not
  // creator-owned. A bio/transcript/pinned-comment negative is creator-level
  // and may reject at stage 0.
  return composition.observedFamilies === 0 && Boolean(input.search_match_context);
}

export function compositionFieldRefs(report: ContextualCompositionReport): EvidenceFieldRef[] {
  const seen = new Set<string>();
  return report.familyClassifications
    .filter(family => TRADING_FOCUSES.has(family.focus))
    .filter(family => {
      const key = `${family.field}:${family.sourceFamilyId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(family => ({ field: family.field, sourceFamilyId: family.sourceFamilyId }));
}
