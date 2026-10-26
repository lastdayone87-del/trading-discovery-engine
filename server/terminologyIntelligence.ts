import type { Pool, PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import type { CountryVocabulary, QueryRecord } from '../src/types';
import type { QueryFunnelMetrics } from './queryPerformance';
import { getDb } from './db';
import { isTerminologyKillSwitchActive, isTerminologyKillSwitchActiveOn } from './terminologyKillSwitch';
import { canonicalCountry } from './countryInference';
import {
  computeEvidenceChecksum,
  computeObservationKey,
  detectCodeSwitching,
  inferScript,
  recomputeNativeEvidenceProjection,
  type NativeEvidenceStatus,
  type SourceProvenanceFamily
} from './countryNativeIntelligence';

export { inferScript } from './countryNativeIntelligence';

type Queryable = Pool | PoolClient | { query: (sql: string, params?: any[]) => Promise<any> };

export type TerminologyLifecycle = 'CANDIDATE' | 'OBSERVED' | 'MULTI_CREATOR_VALIDATED' | 'SEARCH_TRIAL' | 'PROVEN_SEARCH_TERM' | 'DEMOTED';
export type TerminologyObservationType = 'CHANNEL_NAME' | 'VIDEO_TITLE' | 'DESCRIPTION' | 'ENRICHMENT' | 'HUMAN_APPROVED_CHANNEL';
export type TerminologyTermType = 'TERMINOLOGY' | 'INSTRUMENT' | 'PHRASE' | 'FORMAT' | 'BRAND';

export interface TerminologyPolicy {
  halfLifeDays: number;
  observedEvidence: number;
  validationCreators: number;
  validationCommunities: number;
  trialEvidence: number;
  provenExecutions: number;
  provenYield: number;
  demotionExecutions: number;
  demotionYield: number;
}

export const DEFAULT_TERMINOLOGY_POLICY: TerminologyPolicy = {
  halfLifeDays: 90, observedEvidence: 1, validationCreators: 3, validationCommunities: 2,
  trialEvidence: 5, provenExecutions: 3, provenYield: 0.28, demotionExecutions: 5, demotionYield: 0.08
};

export function normalizeTerm(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en');
}

export function decayWeight(observedAt: Date, now: Date, halfLifeDays: number): number {
  const ageDays = Math.max(0, now.getTime() - observedAt.getTime()) / 86_400_000;
  return Math.pow(0.5, ageDays / Math.max(1, halfLifeDays));
}

export function decideLifecycle(input: { current: TerminologyLifecycle; decayedEvidence: number; distinctCreators: number; distinctCommunities: number; executions: number; decayedYield: number; termType: TerminologyTermType }, policy = DEFAULT_TERMINOLOGY_POLICY): { status: TerminologyLifecycle; searchEligible: boolean; reason: string } {
  if (input.executions >= policy.demotionExecutions && input.decayedYield < policy.demotionYield)
    return { status: 'DEMOTED', searchEligible: false, reason: 'Sustained production yield fell below the configured demotion threshold.' };
  if (input.termType === 'BRAND') return { status: input.decayedEvidence >= policy.observedEvidence ? 'OBSERVED' : 'CANDIDATE', searchEligible: false, reason: 'Branding evidence is retained but cannot automatically become a search term.' };
  if (input.executions >= policy.provenExecutions && input.decayedYield >= policy.provenYield)
    return { status: 'PROVEN_SEARCH_TERM', searchEligible: true, reason: 'Repeated executions produced sufficient time-decayed net-new creator yield.' };
  if (input.distinctCreators >= policy.validationCreators && input.distinctCommunities >= policy.validationCommunities && input.decayedEvidence >= policy.trialEvidence)
    return { status: 'SEARCH_TRIAL', searchEligible: true, reason: 'Diverse creator and community evidence qualifies the term for controlled exploration.' };
  if (input.distinctCreators >= policy.validationCreators && input.distinctCommunities >= policy.validationCommunities)
    return { status: 'MULTI_CREATOR_VALIDATED', searchEligible: false, reason: 'Independent creator and community diversity requirements were met.' };
  if (input.decayedEvidence >= policy.observedEvidence) return { status: 'OBSERVED', searchEligible: false, reason: 'Durable normalized evidence has been observed.' };
  return { status: 'CANDIDATE', searchEligible: false, reason: 'Evidence remains below the observation threshold.' };
}

/**
 * Native-discovery quality helpers (literal spans, novelty, spam, translation
 * risk, trial-entry gate, promotion policy). All pure except where noted.
 * Evidence they produce is recorded on terminology_observations evidence
 * JSONB — no schema change. decideLifecycle() below is intentionally
 * untouched: legacy transitions stay byte-identical, and the entry gate in
 * refreshTerminologyLifecycle applies only to terms carrying new
 * qualityVersion evidence.
 */

/** Canonical instrument list mirrored from the rule-based extractor in
 * queryIntelligence.ts (historical spelling preserved). A term matching this
 * list is generic by construction: useful, but never a novel discovery. */
export const KNOWN_INSTRUMENT_TERMS = [
  'NQ', 'ES', 'DAX', 'FDAX', 'CAC 40', 'IBEX 35', 'FTSE 100', 'AEX',
  'BTC', 'ETH', 'EURUSD', 'GBPUSD', 'Gold', 'WTI Crude', 'S&P 500', 'Nasdaq',
];

export interface LiteralSourceText {
  kind: 'CHANNEL_NAME' | 'VIDEO_TITLE' | 'DESCRIPTION';
  index: number;
  text: string;
  videoId?: string | null;
}

export interface LiteralSpanMatch {
  sourceKind: LiteralSourceText['kind'];
  sourceIndex: number;
  span: string;
  videoId?: string | null;
  /**
   * SHA-256 of the NFKC full source text. Observation identity consumes it,
   * so reordered copies deduplicate while different titles mentioning the
   * same term stay distinct — positional index alone cannot do both.
   */
  sourceHash: string;
}

/**
 * Prove a candidate term occurs literally in cited source metadata. Both
 * sides are NFKC-normalized and compared case-insensitively; the returned
 * span is sliced from the normalized source so offsets are always valid.
 * Word-boundary aware for Latin-script terms (so 'ES' never matches inside
 * 'heroes', while 'ES' adjacent to CJK characters still matches); plain
 * substring for terms containing non-Latin characters
 * (CJK and similar scripts have no word boundaries). Returns null when the
 * term cannot be traced to any cited source — model-invented or paraphrased
 * candidates must never enter the evidence ledger.
 */
/**
 * NFKC-normalize while remembering, for each normalized UTF-16 unit, the
 * offset of the source character that produced it. Normalization runs per
 * code point so offsets stay aligned; exotic combining sequences that only
 * normalize across code-point boundaries simply fail to match (fail-closed:
 * candidates are dropped, never misattributed).
 */
function normalizeWithIndexMap(text: string): { normalized: string; indexMap: number[] } {
  const parts: string[] = [];
  const indexMap: number[] = [];
  let i = 0;
  while (i < text.length) {
    const codePoint = text.codePointAt(i) ?? 0;
    const width = codePoint > 0xFFFF ? 2 : 1;
    const chunk = text.slice(i, i + width).normalize('NFKC');
    for (let k = 0; k < chunk.length; k++) indexMap.push(i);
    parts.push(chunk);
    i += width;
  }
  return { normalized: parts.join(''), indexMap };
}

/** Map a [start, end) range in normalized coordinates back to the exact original slice. */
function sliceOriginalSource(text: string, indexMap: number[], start: number, end: number): string {
  const from = indexMap[start] ?? text.length;
  const to = end < indexMap.length ? (indexMap[end] ?? text.length) : text.length;
  if (from >= to) return '';
  return text.slice(from, to);
}

export function findLiteralSpan(term: string, sources: LiteralSourceText[]): LiteralSpanMatch | null {
  // Internal whitespace is significant: only leading/trailing whitespace is
  // trimmed, so 'order  flow' matches 'order  flow' but never 'order flow'.
  const needle = term.normalize('NFKC').trim();
  if (needle.length < 2) return null;
  // Script detection runs on letters only: punctuation such as the en dash
  // in 'order–flow' must not flip the term to the non-Latin path and
  // disable word-boundary guards (which would admit 'order–flow' inside
  // 'disorder–flow'). CJK and other non-Latin letters still take the
  // boundary-free substring path.
  const lettersOnly = needle.replace(/[^\p{L}]/gu, '');
  const hasNonLatin = /[^\u0000-\u024F\u1E00-\u1EFF]/u.test(lettersOnly);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Boundaries guard against Latin-script letters, numbers, and underscores:
  // 'ES' inside 'heroes', 'ES1', or 'ES_Futures' is a fragment, never a term.
  // CJK and similar scripts have no word boundaries, so an instrument
  // adjacent to Han/Hangul/etc. characters still matches.
  const body = hasNonLatin ? escaped : `(?<![\\p{Script=Latin}\\p{N}_])${escaped}(?![\\p{Script=Latin}\\p{N}_])`;
  // Case-insensitive matching is left to the regex engine ('iu'), which folds
  // case per character without changing string lengths — lowercasing both
  // sides first (e.g. Turkish İ → i̇) would shift offsets and corrupt spans.
  const pattern = new RegExp(body, 'giu');
  for (const source of sources) {
    if (!source.text) continue;
    const { normalized, indexMap } = normalizeWithIndexMap(source.text);
    // Every match in the source is tried in order: a first hit that fails
    // round-trip validation (e.g. cutting through a compatibility-character
    // expansion) must not hide a later exact occurrence in the same source.
    for (const match of normalized.matchAll(pattern)) {
      if (match.index === undefined) continue;
      const span = sliceOriginalSource(source.text, indexMap, match.index, match.index + match[0].length);
      if (!span) continue;
      // Round-trip validation: the slice must NFKC-equal the normalized
      // match. Many-to-one expansions (e.g. U+3300 -> katakana sequence) map
      // several normalized units to one source offset, so the slice can end
      // mid-expansion ('不动産' for candidate '不动産アパ') and
      // record provenance that does not contain the candidate. Reject such
      // mappings rather than persisting false provenance.
      if (span.normalize('NFKC') !== match[0]) continue;
      return {
        sourceKind: source.kind,
        sourceIndex: source.index,
        span,
        videoId: source.videoId ?? null,
        sourceHash: createHash('sha256').update(source.text.normalize('NFKC')).digest('hex'),
      };
    }
  }
  return null;
}

export interface TermNovelty {
  novel: boolean;
  /** Where the term was already known, if anywhere. Null when novel. */
  knownAs: string | null;
}

/**
 * Novelty against everything the engine already serves or tracks. Curated
 * country vocabulary, the known-instrument list, and already-extracted terms
 * are supplied by the caller (one cheap read each at the extraction site);
 * comparison is normalized-case. A term unknown everywhere is novel and may
 * enter trial consideration; known terms keep flowing through their existing
 * curated/legacy paths.
 */
export function evaluateTermNovelty(
  term: string,
  context: { country: string; curatedTerms: string[]; knownInstruments?: string[]; existingTerms?: string[] }
): TermNovelty {
  const normalized = normalizeTerm(term);
  const instruments = context.knownInstruments ?? KNOWN_INSTRUMENT_TERMS;
  const hitInstrument = instruments.find(candidate => normalizeTerm(candidate) === normalized);
  if (hitInstrument) return { novel: false, knownAs: `instrument:${hitInstrument}` };
  const hitCurated = context.curatedTerms.find(candidate => normalizeTerm(candidate) === normalized);
  if (hitCurated) return { novel: false, knownAs: `curated:${context.country}:${hitCurated}` };
  const hitExtracted = (context.existingTerms ?? []).find(candidate => normalizeTerm(candidate) === normalized);
  if (hitExtracted) return { novel: false, knownAs: `extracted:${hitExtracted}` };
  return { novel: true, knownAs: null };
}

/** Strong signal-selling / promotional patterns. A trading term matching any
 * of these is junk by construction — never a legitimate local methodology
 * name (which never contains join/WhatsApp/promo/giveaway language). Kept
 * deliberately narrow to avoid false positives on real terms. */
const SPAM_SIGNAL_PATTERNS: Array<{ pattern: RegExp; code: string }> = [
  { pattern: /\b(join|free|vip|premium)\b.{0,20}\b(signals?|group|channel|vip)\b/i, code: 'signal-group-solicitation' },
  { pattern: /\b(whatsapp|telegram)\b.{0,20}\b(join|free|signals?|vip|group)\b/i, code: 'messenger-solicitation' },
  // Localized solicitation (FR/DE/ES): the same join/free ↔ signals/group
  // pairing as the English patterns, scoped to supported-language vocabulary.
  // Bare words never match — the pairing requirement keeps legitimate local
  // trading language (e.g. 'Analyse Technique', 'Börsenanalyse') clean.
  { pattern: /\b(rejoignez|rejoindre|gratuit|gratuite|gratuits)\b.{0,20}\b(signaux|signal|groupe|canal|vip)\b/i, code: 'signal-group-solicitation-fr' },
  { pattern: /\b(signaux|groupe|canal)\b.{0,20}\b(gratuit|gratuite|gratuits|rejoignez|vip)\b/i, code: 'signal-group-solicitation-fr' },
  { pattern: /\b(beitreten|tritt bei|kostenlose?|gratis)\b.{0,20}\b(signale|gruppe|kanal|vip)\b/i, code: 'signal-group-solicitation-de' },
  // Unicode-letter-aware boundaries (not \b): per ECMAScript, \b is
  // ASCII-only even with the `u` flag, so no boundary exists before 'ú' and
  // 'únete al grupo' would evade screening. The `u` flag is still required
  // for \p{} and lookbehind.
  { pattern: /(?<![\p{L}\p{N}_])(\u00fanete|unete|gratis|gratuito|gratuita)(?![\p{L}\p{N}_]).{0,20}(?<![\p{L}\p{N}_])(se\u00f1ales|se\u00f1al|grupo|canal|vip)(?![\p{L}\p{N}_])/iu, code: 'signal-group-solicitation-es' },
  { pattern: /(?<![\p{L}\p{N}_])(se\u00f1ales|se\u00f1al|grupo|canal)(?![\p{L}\p{N}_]).{0,20}(?<![\p{L}\p{N}_])(\u00fanete|unete|gratis|gratuito|gratuita|vip)(?![\p{L}\p{N}_])/iu, code: 'signal-group-solicitation-es' },
  { pattern: /\b(promo( code)?|discount|giveaway|bonus|airdrop)\b/i, code: 'promotional' },
  { pattern: /\b(guaranteed|risk.?free|double your|1000?x gains?)\b/i, code: 'guaranteed-returns' },
  { pattern: /[$€£¥₹]\s*\d|💰|🚀|🔥|💸|🤑|💵/i, code: 'money-bait' },
  { pattern: /\b(click (here|link|below)|link in (bio|description))\b/i, code: 'engagement-bait' },
];

/** Returns matched spam reason codes, or [] for clean terms. */
export function detectSpamSignals(term: string): string[] {
  // Screen the NFKC-normalized candidate so Unicode compatibility characters
  // (e.g. 'Ⓓiscount' for 'discount') cannot bypass the patterns. Screening
  // never alters the candidate itself: persistence and source spans always
  // use the original text (see classifyNativeCandidate / findLiteralSpan).
  const screened = term.normalize('NFKC');
  const hits: string[] = [];
  for (const { pattern, code } of SPAM_SIGNAL_PATTERNS) {
    if (pattern.test(screened)) hits.push(code);
  }
  return [...new Set(hits)];
}

export interface TermQualityFlags {
  generic: boolean;
  translationRisk: string | null;
}

/**
 * Evidence-only quality flags (never block extraction by themselves):
 * generic marks terms the engine already serves (curated/instruments);
 * translationRisk marks ASCII-only terms observed under a non-Latin-script
 * language context as possibly translated rather than native. Both are
 * heuristic and documented as such; they inform trial/promotion review.
 */
const NON_LATIN_SCRIPT_LANGUAGES = new Set([
  'ja', 'zh', 'ko', 'th', 'ar', 'he', 'fa', 'ur', 'ru', 'uk', 'bg', 'el',
  'hi', 'bn', 'ta', 'te', 'mr', 'tr', 'ka', 'hy', 'az', 'kk',
]);

export function evaluateTermQualityFlags(
  term: string,
  context: { language?: string; curatedTerms: string[]; knownInstruments?: string[] }
): TermQualityFlags {
  const normalized = normalizeTerm(term);
  const inLists = (list: string[]) => list.some(candidate => normalizeTerm(candidate) === normalized);
  const generic =
    inLists(context.knownInstruments ?? KNOWN_INSTRUMENT_TERMS) || inLists(context.curatedTerms);
  let translationRisk: string | null = null;
  const language = (context.language || '').toLowerCase().split('-')[0];
  if (
    language &&
    language !== 'und' &&
    language !== 'en' &&
    NON_LATIN_SCRIPT_LANGUAGES.has(language) &&
    /^[\x00-\x7F]*$/.test(term)
  ) {
    translationRisk = 'ascii-in-non-latin-context';
  }
  return { generic, translationRisk };
}

/**
 * Novelty baseline assembled from the lookups the extraction site performs.
 * Fail-closed by construction: when either lookup failed, `ok` is false and
 * no positive novelty may be recorded from this baseline (see
 * classifyNativeCandidate). A transient read error must never make a known
 * term look novel.
 */
export interface NoveltyBaseline {
  ok: boolean;
  country: string;
  curatedTerms: string[];
  existingTerms: string[];
  failed: Array<'curated' | 'existing'>;
}

export function buildNoveltyBaseline(args: {
  country: string;
  vocab: CountryVocabulary | undefined;
  vocabOk: boolean;
  existingTerms: string[];
  existingOk: boolean;
}): NoveltyBaseline {
  const failed: Array<'curated' | 'existing'> = [];
  // A missing country row is an unknown baseline even when the lookup itself
  // succeeded: without the country-specific curated vocabulary, known terms
  // would falsely classify as novel.
  if (!args.vocabOk || args.vocab === undefined) failed.push('curated');
  if (!args.existingOk) failed.push('existing');
  return {
    ok: failed.length === 0,
    country: args.country,
    curatedTerms:
      args.vocabOk && args.vocab
        ? [
            ...(args.vocab.native_trading_terminology || []),
            ...(args.vocab.popular_instruments || []),
            ...(args.vocab.local_market_phrases || []),
            ...(args.vocab.common_content_format_names || []),
          ]
        : [],
    existingTerms: args.existingOk ? [...args.existingTerms] : [],
    failed,
  };
}

export type NativeCandidateRejectionReason =
  | 'non-string'
  | 'too-short'
  | 'non-literal'
  | 'spam'
  | 'novelty-unknown';

export interface NativeCandidateAdmission {
  admit: true;
  located: LiteralSpanMatch;
  novelty: TermNovelty;
  flags: TermQualityFlags;
  spamSignals: string[];
  /** Solicitation signals in the matched source text (evidence-only). */
  sourceSpamSignals: string[];
}

export interface NativeCandidateRejection {
  admit: false;
  reason: NativeCandidateRejectionReason;
  spamSignals: string[];
}

export type NativeCandidateVerdict = NativeCandidateAdmission | NativeCandidateRejection;

/** Rejection reasons for extraction-site admission reporting, including the
 * persistence-ordering outcome (observation never recorded). */
export type NativeAdmissionRejectReason = NativeCandidateRejectionReason | 'observation-failed';

/**
 * Pure admission classifier: literal traceability → spam screening →
 * fail-closed novelty → quality flags. Pure and fully unit-testable; the
 * extraction site (queryIntelligence) only persists candidates this admits,
 * recording terminology evidence before the extracted-term row (see
 * admitNativeCandidates). Never throws for malformed input.
 */
export function classifyNativeCandidate(
  raw: unknown,
  sources: LiteralSourceText[],
  baseline: NoveltyBaseline,
  opts: { language?: string }
): NativeCandidateVerdict {
  if (typeof raw !== 'string') return { admit: false, reason: 'non-string', spamSignals: [] };
  if (raw.normalize('NFKC').trim().length < 2) return { admit: false, reason: 'too-short', spamSignals: [] };
  const located = findLiteralSpan(raw, sources);
  if (!located) return { admit: false, reason: 'non-literal', spamSignals: [] };
  const spamSignals = detectSpamSignals(raw);
  if (spamSignals.length > 0) return { admit: false, reason: 'spam', spamSignals };
  if (!baseline.ok) return { admit: false, reason: 'novelty-unknown', spamSignals };
  const novelty = evaluateTermNovelty(raw, {
    country: baseline.country,
    curatedTerms: baseline.curatedTerms,
    existingTerms: baseline.existingTerms,
  });
  const flags = evaluateTermQualityFlags(raw, { language: opts.language, curatedTerms: baseline.curatedTerms });
  const matchedSource = sources.find(
    source => source.kind === located.sourceKind && source.index === located.sourceIndex
  );
  const sourceSpamSignals = matchedSource ? detectSpamSignals(matchedSource.text) : [];
  return { admit: true, located, novelty, flags, spamSignals, sourceSpamSignals };
}

/**
 * Trial-entry gate for terms carrying new quality evidence. Spam-confirmed
 * terms never enter; non-novel terms never (re)enter trial or proven states
 * through new evidence (generics stay served via curated/legacy paths).
 * Only governs entry into search-eligible states — never forces exit, so
 * demotion stays exclusively yield-driven and existing terms are untouched
 * until they accumulate new evidence.
 */
export function evaluateTrialEntry(input: { novel: boolean; spamConfirmed: boolean }): {
  allowed: boolean;
  reasons: string[];
} {
  if (input.spamConfirmed) return { allowed: false, reasons: ['spam-confirmed'] };
  if (!input.novel) return { allowed: false, reasons: ['not-novel'] };
  return { allowed: true, reasons: ['novel-eligible'] };
}

export interface NativePromotionMetrics {
  yieldPer1000Quota: number;
  confirmedShare: number;
  wrongCountryShare: number;
  reviewShare: number;
}

/** Initial promotion policy thresholds. Reviewable operator policy: raise
 * the yield bar or tighten shares as evidence accumulates. */
export const NATIVE_PROMOTION_MIN_YIELD_PER_1000_QUOTA = 1.0;
export const NATIVE_PROMOTION_MAX_WRONG_COUNTRY_SHARE = 0.5;
export const NATIVE_PROMOTION_REVIEW_HOLD_SHARE = 0.5;
export const NATIVE_PROMOTION_MIN_EXECUTIONS = 3;
export const NATIVE_PROMOTION_MIN_CREATORS = 3;

/**
 * Promotion policy for native term trials (pure; operator/trial decisions,
 * never auto-applied). Dimensions per mandate: verified new trading
 * creators per quota unit, country/language precision (wrong-country
 * share), duplicates (deduped upstream: distinct creators/communities
 * inputs), non-trading results, source independence (distinct communities +
 * burst flag), review burden (needs-review share holds, never auto-promotes),
 * and uncertainty (minimum-evidence floors hold instead of deciding).
 * Novelty is required: generic terms are served via curated paths already.
 */
export function evaluateNativeTermPromotion(input: {
  novel: boolean;
  spamConfirmed: boolean;
  executions: number;
  quotaConsumed: number;
  confirmedTradingCreators: number;
  nonTradingCreators: number;
  wrongCountryCreators: number;
  needsReviewCreators: number;
  distinctCreators: number;
  distinctCommunities: number;
  coordinatedBurst: boolean;
}): { decision: 'PROMOTE' | 'HOLD' | 'REJECT'; reasons: string[]; metrics: NativePromotionMetrics } {
  const reasons: string[] = [];
  if (input.spamConfirmed) {
    return { decision: 'REJECT', reasons: ['spam-confirmed'], metrics: emptyPromotionMetrics() };
  }
  if (!input.novel) {
    return { decision: 'REJECT', reasons: ['not-novel: generics served via curated paths'], metrics: emptyPromotionMetrics() };
  }
  if (input.executions < NATIVE_PROMOTION_MIN_EXECUTIONS) {
    reasons.push(`insufficient-executions:${input.executions}<${NATIVE_PROMOTION_MIN_EXECUTIONS}`);
  }
  if (input.distinctCreators < NATIVE_PROMOTION_MIN_CREATORS) {
    reasons.push(`insufficient-creators:${input.distinctCreators}<${NATIVE_PROMOTION_MIN_CREATORS}`);
  }
  if (input.quotaConsumed <= 0) {
    reasons.push('no-quota-basis');
  }
  // Attribution buckets are disjoint by construction: every attributed creator
  // lands in exactly one bucket (confirmed / non-trading / wrong-country /
  // needs-review), so shares are exact and no creator is double-counted.
  const totalAttributed =
    input.confirmedTradingCreators + input.nonTradingCreators +
    input.wrongCountryCreators + input.needsReviewCreators;
  const metrics: NativePromotionMetrics = {
    // Verified-trader yield only: unverified or review-only discoveries can
    // never satisfy the promotion bar on their own.
    yieldPer1000Quota: input.quotaConsumed > 0 ? (1000 * input.confirmedTradingCreators) / input.quotaConsumed : 0,
    confirmedShare: totalAttributed > 0 ? input.confirmedTradingCreators / totalAttributed : 0,
    wrongCountryShare: totalAttributed > 0 ? input.wrongCountryCreators / totalAttributed : 0,
    reviewShare: totalAttributed > 0 ? input.needsReviewCreators / totalAttributed : 0,
  };
  if (reasons.length > 0) return { decision: 'HOLD', reasons, metrics };
  if (input.coordinatedBurst && input.distinctCommunities < 2) {
    return { decision: 'HOLD', reasons: ['coordinated-burst: single-community concentration needs review'], metrics };
  }
  if (metrics.wrongCountryShare > NATIVE_PROMOTION_MAX_WRONG_COUNTRY_SHARE) {
    return { decision: 'REJECT', reasons: [`wrong-country-share:${metrics.wrongCountryShare.toFixed(2)}`], metrics };
  }
  // Verified-trader evidence is required independently of non-trading volume:
  // a trial with zero confirmed trading creators holds for verification even
  // when nothing contradicts it yet (review-only or unattributed outcomes).
  if (input.confirmedTradingCreators < 1) {
    return { decision: 'HOLD', reasons: ['no-verified-traders'], metrics };
  }
  if (metrics.reviewShare > NATIVE_PROMOTION_REVIEW_HOLD_SHARE) {
    return { decision: 'HOLD', reasons: [`review-burden:${metrics.reviewShare.toFixed(2)}`], metrics };
  }
  if (metrics.yieldPer1000Quota < NATIVE_PROMOTION_MIN_YIELD_PER_1000_QUOTA) {
    return { decision: 'HOLD', reasons: [`yield-below-bar:${metrics.yieldPer1000Quota.toFixed(2)}`], metrics };
  }
  return { decision: 'PROMOTE', reasons: ['meets-native-promotion-bar'], metrics };
}

function emptyPromotionMetrics(): NativePromotionMetrics {
  return { yieldPer1000Quota: 0, confirmedShare: 0, wrongCountryShare: 0, reviewShare: 0 };
}

// ---------------------------------------------------------------------------
// Native evidence v2: lifecycle and promotion policy
// ---------------------------------------------------------------------------

export const NATIVE_V2_MAX_WRONG_COUNTRY_SHARE = 0.25;
export const NATIVE_V2_NO_PROVEN_WRONG_COUNTRY_SHARE = 0.10;
export const NATIVE_V2_REVOKE_TRIAL_REVIEW_SHARE = 0.25;
export const NATIVE_V2_NO_PROVEN_REVIEW_SHARE = 0.20;
export const NATIVE_V2_DEMOTE_REVIEW_SHARE = 0.40;
export const NATIVE_V2_MIN_CONFIRMED_SHARE = 0.50;

export interface LifecycleV2Input {
  current: TerminologyLifecycle;
  termType: TerminologyTermType;
  decayedEvidence: number;
  nativeCreators: number;
  /**
   * Native independence buckets: creators grouped by a non-null community
   * fingerprint, or by creator when no fingerprint exists. Three copies of the
   * same community count as one bucket, not three creators (T6).
   */
  nativeEvidenceBuckets?: number;
  /**
   * Distinct external independence buckets. `externalEligible` is true only
   * when at least two independent sources from at least two families match
   * the local surface (the evaluateExternalTermEvidence contract).
   */
  externalSources: number;
  externalSourceCount?: number;
  externalEligible?: boolean;
  /**
   * Trial-evidence units contributed by qualified independent external
   * sources. External evidence lives outside terminology_observations, so the
   * native decayed-evidence score cannot represent it; each independent
   * external bucket contributes one unit toward the same trial threshold.
   */
  externalTrialEvidenceScore?: number;
  confirmedTradingCreators: number;
  nonTradingCreators: number;
  wrongCountryCreators: number;
  needsReviewCreators: number;
  executions: number;
  decayedYield: number;
  quotaConsumed: number;
  /** Coordinated-burst flag; three buckets hold until a fourth independent bucket. */
  coordinatedBurst?: boolean;
}

export interface LifecycleV2Decision {
  status: TerminologyLifecycle;
  searchEligible: boolean;
  reason: string;
}

/**
 * V2 lifecycle policy: Discord communities are no longer a promotion gate.
 * Independence comes from promotion-eligible native creators or independently
 * corroborated external evidence. The PROVEN bar reuses
 * evaluateNativeTermPromotionV2, so wrong-country and review-burden caps are
 * applied before any promotion. Pure; refresh persists the result.
 */
export function decideLifecycleV2(
  input: LifecycleV2Input,
  policy = DEFAULT_TERMINOLOGY_POLICY
): LifecycleV2Decision {
  const totalAttributed =
    input.confirmedTradingCreators + input.nonTradingCreators +
    input.wrongCountryCreators + input.needsReviewCreators;
  const confirmedShare = totalAttributed > 0 ? input.confirmedTradingCreators / totalAttributed : 0;
  const wrongCountryShare = totalAttributed > 0 ? input.wrongCountryCreators / totalAttributed : 0;
  const reviewShare = totalAttributed > 0 ? input.needsReviewCreators / totalAttributed : 0;
  const nativeBuckets = Math.max(0, input.nativeEvidenceBuckets ?? input.nativeCreators);
  const externalSourceCount = Math.max(0, input.externalSourceCount ?? input.externalSources);
  const externalEligible = input.externalEligible ?? externalSourceCount >= 2;
  const nativeBasis = nativeBuckets >= policy.validationCreators;
  const mixedBasis = nativeBuckets >= 2 && externalSourceCount >= 1;
  const externalOnlyBasis = externalEligible && input.nativeCreators === 0;
  const validationBasis = nativeBasis || mixedBasis || externalOnlyBasis;
  const tradingValidNativeBasis =
    nativeBasis && input.confirmedTradingCreators >= 1 && confirmedShare >= NATIVE_V2_MIN_CONFIRMED_SHARE;
  const externalTrialEvidence = externalOnlyBasis &&
    input.decayedEvidence + Math.max(0, input.externalTrialEvidenceScore ?? 0) >= policy.trialEvidence;
  const nativeTrialEvidence =
    (nativeBasis || mixedBasis) &&
    input.decayedEvidence >= policy.trialEvidence &&
    tradingValidNativeBasis;
  const trialEvidence = externalTrialEvidence || nativeTrialEvidence;

  if (input.executions >= policy.demotionExecutions && input.decayedYield < policy.demotionYield) {
    return { status: 'DEMOTED', searchEligible: false, reason: 'Sustained production yield fell below the configured demotion threshold.' };
  }
  if (input.termType === 'BRAND') {
    return {
      status: input.decayedEvidence >= policy.observedEvidence ? 'OBSERVED' : 'CANDIDATE',
      searchEligible: false,
      reason: 'Branding evidence is retained but cannot automatically become a search term.',
    };
  }
  if (wrongCountryShare > NATIVE_V2_MAX_WRONG_COUNTRY_SHARE) {
    return {
      status: 'DEMOTED',
      searchEligible: false,
      reason: `Wrong-country share ${wrongCountryShare.toFixed(2)} exceeds the ${NATIVE_V2_MAX_WRONG_COUNTRY_SHARE} cap; trial revoked until new independent evidence clears the gates.`,
    };
  }
  if (reviewShare > NATIVE_V2_DEMOTE_REVIEW_SHARE) {
    return {
      status: 'DEMOTED',
      searchEligible: false,
      reason: `Review burden ${reviewShare.toFixed(2)} exceeds the ${NATIVE_V2_DEMOTE_REVIEW_SHARE} demotion cap.`,
    };
  }
  // Coordinated bursts need a fourth independent bucket before they can leave
  // HOLD. Three buckets (the minimum validation basis) are not enough when the
  // evidence looks coordinated.
  if (validationBasis && input.coordinatedBurst === true && nativeBuckets < 4) {
    return {
      status: 'MULTI_CREATOR_VALIDATED',
      searchEligible: false,
      reason: `Coordinated burst with ${nativeBuckets} independence bucket(s); holding until a fourth independent bucket is observed.`,
    };
  }
  if (validationBasis) {
    const verdict = evaluateNativeTermPromotionV2({
      novel: null,
      spamConfirmed: false,
      executions: input.executions,
      quotaConsumed: input.quotaConsumed,
      confirmedTradingCreators: input.confirmedTradingCreators,
      nonTradingCreators: input.nonTradingCreators,
      wrongCountryCreators: input.wrongCountryCreators,
      needsReviewCreators: input.needsReviewCreators,
      validationBasis,
      decayedEvidence: input.decayedEvidence,
      decayedYield: input.decayedYield,
    });
    if (verdict.decision === 'PROMOTE') {
      return { status: 'PROVEN_SEARCH_TERM', searchEligible: true, reason: verdict.reasons.join('; ') };
    }
  }
  if (reviewShare > NATIVE_V2_REVOKE_TRIAL_REVIEW_SHARE) {
    return {
      status: validationBasis ? 'MULTI_CREATOR_VALIDATED' : 'OBSERVED',
      searchEligible: false,
      reason: `Review burden ${reviewShare.toFixed(2)} exceeds the ${NATIVE_V2_REVOKE_TRIAL_REVIEW_SHARE} trial-revocation cap.`,
    };
  }
  if (validationBasis && trialEvidence) {
    return {
      status: 'SEARCH_TRIAL',
      searchEligible: true,
      reason: externalOnlyBasis
        ? 'Independently corroborated external evidence qualifies the term for controlled exploration.'
        : 'Independent native creators and trading-valid evidence qualify the term for controlled exploration.',
    };
  }
  // Existing search eligibility is not revoked merely because a fresh
  // confirmed-trader share check would fail to promote a new trial. The term
  // stays on trial (search-eligible) until a yield, wrong-country, or review
  // cap explicitly demotes/revokes it (T11). New trials still need the full
  // trading-valid basis.
  if (
    validationBasis &&
    (input.current === 'SEARCH_TRIAL' || input.current === 'PROVEN_SEARCH_TERM') &&
    input.decayedEvidence >= policy.trialEvidence &&
    confirmedShare < NATIVE_V2_MIN_CONFIRMED_SHARE
  ) {
    return {
      status: 'SEARCH_TRIAL',
      searchEligible: true,
      reason: `Existing trial retained; confirmed-trader share ${confirmedShare.toFixed(2)} is below the new-promotion bar.`,
    };
  }
  if (validationBasis) {
    return {
      status: 'MULTI_CREATOR_VALIDATED',
      searchEligible: false,
      reason: 'Independent validation basis met; trial evidence or trading-valid native evidence is still insufficient.',
    };
  }
  if (input.nativeCreators >= 1 || input.externalSources >= 1 || input.decayedEvidence >= policy.observedEvidence) {
    return { status: 'OBSERVED', searchEligible: false, reason: 'Durable normalized evidence has been observed.' };
  }
  return { status: 'CANDIDATE', searchEligible: false, reason: 'Evidence remains below the observation threshold.' };
}

/**
 * V2 promotion bar. Extends the native-v1 dimensions with the tightened
 * wrong-country and review-burden caps, and replaces the Discord-community
 * gate with a caller-supplied validation basis (native creators or external
 * corroboration). Novelty is skipped only when `novel === null`, which is the
 * external-only case with no native-v1 quality evidence.
 */
export function evaluateNativeTermPromotionV2(input: {
  novel: boolean | null;
  spamConfirmed: boolean;
  executions: number;
  quotaConsumed: number;
  confirmedTradingCreators: number;
  nonTradingCreators: number;
  wrongCountryCreators: number;
  needsReviewCreators: number;
  validationBasis: boolean;
  decayedEvidence: number;
  decayedYield: number;
}): { decision: 'PROMOTE' | 'HOLD' | 'REJECT'; reasons: string[]; metrics: NativePromotionMetrics } {
  const reasons: string[] = [];
  if (input.spamConfirmed) {
    return { decision: 'REJECT', reasons: ['spam-confirmed'], metrics: emptyPromotionMetrics() };
  }
  if (input.novel === false) {
    return { decision: 'REJECT', reasons: ['not-novel: generics served via curated paths'], metrics: emptyPromotionMetrics() };
  }
  const totalAttributed =
    input.confirmedTradingCreators + input.nonTradingCreators +
    input.wrongCountryCreators + input.needsReviewCreators;
  const metrics: NativePromotionMetrics = {
    yieldPer1000Quota: input.quotaConsumed > 0 ? (1000 * input.confirmedTradingCreators) / input.quotaConsumed : 0,
    confirmedShare: totalAttributed > 0 ? input.confirmedTradingCreators / totalAttributed : 0,
    wrongCountryShare: totalAttributed > 0 ? input.wrongCountryCreators / totalAttributed : 0,
    reviewShare: totalAttributed > 0 ? input.needsReviewCreators / totalAttributed : 0,
  };
  if (!input.validationBasis) reasons.push('insufficient-independent-evidence');
  if (input.executions < NATIVE_PROMOTION_MIN_EXECUTIONS) {
    reasons.push(`insufficient-executions:${input.executions}<${NATIVE_PROMOTION_MIN_EXECUTIONS}`);
  }
  if (input.quotaConsumed <= 0) reasons.push('no-quota-basis');
  if (input.decayedYield < 0.28) reasons.push(`decayed-yield-below-bar:${input.decayedYield.toFixed(2)}<0.28`);
  if (metrics.yieldPer1000Quota < NATIVE_PROMOTION_MIN_YIELD_PER_1000_QUOTA) {
    reasons.push(`yield-below-bar:${metrics.yieldPer1000Quota.toFixed(2)}`);
  }
  if (metrics.wrongCountryShare > NATIVE_V2_MAX_WRONG_COUNTRY_SHARE) {
    return { decision: 'REJECT', reasons: [`wrong-country-share:${metrics.wrongCountryShare.toFixed(2)}`], metrics };
  }
  if (metrics.reviewShare > NATIVE_V2_DEMOTE_REVIEW_SHARE) {
    return { decision: 'REJECT', reasons: [`review-burden-demote:${metrics.reviewShare.toFixed(2)}`], metrics };
  }
  if (input.confirmedTradingCreators < 1) reasons.push('no-verified-traders');
  if (metrics.confirmedShare < NATIVE_V2_MIN_CONFIRMED_SHARE) {
    reasons.push(`confirmed-share-below-bar:${metrics.confirmedShare.toFixed(2)}<${NATIVE_V2_MIN_CONFIRMED_SHARE}`);
  }
  if (metrics.wrongCountryShare > NATIVE_V2_NO_PROVEN_WRONG_COUNTRY_SHARE) {
    reasons.push(`wrong-country-share-no-proven:${metrics.wrongCountryShare.toFixed(2)}`);
  }
  if (metrics.reviewShare > NATIVE_V2_NO_PROVEN_REVIEW_SHARE) {
    reasons.push(`review-burden-no-proven:${metrics.reviewShare.toFixed(2)}`);
  }
  if (reasons.length > 0) return { decision: 'HOLD', reasons, metrics };
  return { decision: 'PROMOTE', reasons: ['meets-native-v2-promotion-bar'], metrics };
}

export interface ExternalTermEvidenceRow {
  sourceId: string;
  sourceFamily: string;
  correlationKey?: string | null;
  observedAt: string;
  confidence: number;
  reliability: number;
  relevance: number;
  surface: string;
  language: string;
  script: string;
}

export interface ExternalTermEvidenceResult {
  eligible: boolean;
  independentSources: number;
  families: string[];
  reasons: string[];
}

/**
 * External corroboration for a local term. Only the term's normalized local
 * surface or a governed alias matches — an English canonical_concept alone
 * never promotes a local-language term. TREND_SURFACE is excluded, and the
 * strength/freshness/script criteria mirror aggregateOsintEvidence.
 */
export function evaluateExternalTermEvidence(args: {
  term: string;
  aliases: string[];
  language?: string | null;
  script?: string | null;
  rows: ExternalTermEvidenceRow[];
  now?: Date;
}): ExternalTermEvidenceResult {
  const target = normalizeTerm(args.term);
  const aliasSet = new Set(args.aliases.map(normalizeTerm));
  const now = args.now || new Date();
  const reasons: string[] = [];
  const matching = args.rows.filter(row => {
    const surface = normalizeTerm(row.surface);
    if (surface !== target && !aliasSet.has(surface)) return false;
    if (String(row.sourceFamily).toUpperCase() === 'TREND_SURFACE') return false;
    const observed = Date.parse(row.observedAt);
    const ageMs = now.getTime() - observed;
    // Future-dated rows are not fresh corroboration: an age-only check would
    // let a bad clock or forged timestamp validate a term indefinitely.
    // Allow only a small skew for clock drift between collectors.
    if (!Number.isFinite(observed) || ageMs > 30 * 86_400_000 || ageMs < -5 * 60_000) return false;
    return true;
  });
  const targetLanguage = (args.language || '').split('-')[0].toLowerCase();
  const languageMatched = targetLanguage && targetLanguage !== 'und'
    ? matching.filter(row => String(row.language || '').split('-')[0].toLowerCase() === targetLanguage)
    : matching;
  const targetScript = (args.script || '').toUpperCase();
  const scriptMatched = targetScript && targetScript !== 'ZYYY'
    ? languageMatched.filter(row => String(row.script || '').toUpperCase() === targetScript)
    : languageMatched;
  if (scriptMatched.length === 0) {
    return { eligible: false, independentSources: 0, families: [], reasons: ['NO_MATCHING_LOCAL_SURFACE'] };
  }
  const scripts = new Set(scriptMatched.map(row => String(row.script || '').toUpperCase()));
  if (scripts.size !== 1) reasons.push('SCRIPT_CONFLICT');
  const buckets = new Map<string, Set<string>>();
  const families = new Set<string>();
  let weightedSum = 0;
  for (const row of scriptMatched) {
    const key = row.correlationKey?.trim().toLowerCase() || `source:${row.sourceId.trim().toLowerCase()}`;
    const bucket = buckets.get(key) || new Set<string>();
    bucket.add(row.sourceId.trim().toLowerCase());
    buckets.set(key, bucket);
    families.add(String(row.sourceFamily).toUpperCase());
    weightedSum += Math.min(1, Math.max(0, row.confidence))
      * Math.min(1, Math.max(0, row.reliability))
      * Math.min(1, Math.max(0, row.relevance));
  }
  const weighted = weightedSum / scriptMatched.length;
  if (buckets.size < 2) reasons.push('INSUFFICIENT_INDEPENDENT_SOURCES');
  if (families.size < 2) reasons.push('INSUFFICIENT_SOURCE_FAMILIES');
  if (weighted < 0.55) reasons.push('INSUFFICIENT_EVIDENCE_STRENGTH');
  return {
    eligible: reasons.length === 0,
    independentSources: buckets.size,
    families: [...families].sort(),
    reasons,
  };
}

export interface NativeQualityRollup {
  v1Observations: number;
  spamConfirmed: boolean;
  novel: boolean;
}

/**
 * Quality rollup over the exact evidence shape the observation writers
 * persist (top-level qualityVersion / novel / spamSignals / spamConfirmed —
 * there is no evidence.quality object). Pure so tests exercise the real
 * writer shape instead of a mocked aggregate.
 *
 * Spam screening rejects candidates before persistence, so spam-flagged rows
 * arise only from out-of-band writes — but when present they must gate trial
 * entry, hence the spamSignals-array fallback alongside the canonical
 * spamConfirmed flag.
 */
export function rollupNativeQualityEvidence(
  evidenceRows: Array<Record<string, unknown> | null | undefined>
): NativeQualityRollup {
  let v1Observations = 0;
  let spamConfirmed = false;
  let novel = false;
  for (const evidence of evidenceRows) {
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) continue;
    if (evidence.qualityVersion !== 'native-v1') continue;
    v1Observations += 1;
    if (
      evidence.spamConfirmed === true ||
      (Array.isArray(evidence.spamSignals) && evidence.spamSignals.length > 0)
    ) {
      spamConfirmed = true;
    }
    if (evidence.novel === true) novel = true;
  }
  return { v1Observations, spamConfirmed, novel };
}

/**
 * Quality rollup over new-pipeline observations for one term, aggregated in
 * SQL: refresh runs on every new observation and every attribution, so the
 * result stays fixed-size no matter how large a term's history grows. Terms
 * with only legacy observations return v1Observations 0 and keep legacy
 * rules.
 *
 * The predicates mirror rollupNativeQualityEvidence exactly (kept as the
 * unit-tested reference implementation): a single evidence set restricted to
 * native-v1 rows, top-level qualityVersion marker, canonical spamConfirmed
 * boolean with the persisted spamSignals-array fallback, top-level novel
 * boolean. Legacy-only terms therefore aggregate to v1=0/false/false and
 * keep legacy rules on both paths; legacy or out-of-band rows carrying novel
 * or spam flags can neither admit a non-novel term nor block trial entry.
 * jsonb_typeof CASE guards keep a single malformed out-of-band row from
 * failing a cast or array-length call and aborting the whole refresh —
 * non-boolean flags read as false on both paths. (CASE, not AND, guards the
 * array-length call: PostgreSQL does not guarantee AND evaluation order.)
 */
export const NATIVE_QUALITY_ROLLUP_SQL =
  `SELECT count(*)::int AS v1,
    COALESCE(bool_or(
      CASE WHEN jsonb_typeof(evidence->'spamConfirmed') = 'boolean' THEN (evidence->>'spamConfirmed')::boolean ELSE false END
      OR CASE WHEN jsonb_typeof(evidence->'spamSignals') = 'array' THEN COALESCE(jsonb_array_length(evidence->'spamSignals') > 0, false) ELSE false END
    ), false) AS spam,
    COALESCE(bool_or(
      CASE WHEN jsonb_typeof(evidence->'novel') = 'boolean' THEN (evidence->>'novel')::boolean ELSE false END
    ), false) AS novel
   FROM terminology_observations WHERE canonical_term_id=$1 AND evidence->>'qualityVersion'='native-v1'`;

/** V2 quality rollup counts only promotion-eligible observations. */
export const NATIVE_QUALITY_ROLLUP_V2_SQL = `${NATIVE_QUALITY_ROLLUP_SQL} AND promotion_eligible=true`;

export async function readNativeQualityEvidence(
  termId: number,
  runner: Queryable,
  sql: string = NATIVE_QUALITY_ROLLUP_SQL
): Promise<NativeQualityRollup> {
  const result = await runner.query(sql, [termId]);
  const row = ((result.rows || [])[0] || {}) as Record<string, unknown>;
  return {
    v1Observations: Number(row.v1 || 0),
    spamConfirmed: row.spam === true,
    novel: row.novel === true,
  };
}

export interface TerminologyObservationResult {
  termId: number;
  /** True only when INSERT ... ON CONFLICT actually inserted a new observation row. */
  observationInserted: boolean;
}

/**
 * Per-term lifecycle serialization lock. Acquires a transaction-scoped
 * advisory lock BEFORE the transaction writes any terminology row for the
 * term. Universal lock order across observation, attribution, and refresh:
 * advisory first, row writes after — no transaction ever holds term-row
 * locks (ROW EXCLUSIVE updates, FK KEY SHARE checks) while requesting this
 * lock, so the KEY SHARE -> row-lock upgrade deadlock cannot form.
 * Re-entrant within a session (repeat acquisition is a no-op until commit).
 *
 * Transaction contract: the lock is transaction-scoped, so it only protects
 * statements that share the acquirer's transaction. Pool runners are wrapped
 * in an owned transaction by observe/refresh/attribute before acquisition;
 * a caller-supplied client MUST already be inside a transaction (as in
 * completeQueryRun, which BEGINs before attribution). A bare autocommit
 * client degrades gracefully — statements still execute correctly in order,
 * but without cross-statement serialization. All production callers comply:
 * observe/attribute/refresh self-wrap Pools, and the sole external client
 * supplier (completeQueryRun) is transaction-bound.
 */
export async function acquireTerminologyLifecycleLock(termId: number, runner: Queryable): Promise<void> {
  await runner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`terminology-lifecycle:${termId}`]);
}

export async function observeTerminologyDetailed(args: {
  term: string;
  country: string;
  language?: string;
  termType: TerminologyTermType;
  observationType: TerminologyObservationType;
  channelId?: string;
  videoId?: string;
  humanApproved?: boolean;
  humanApprovalId?: string;
  communityFingerprint?: string;
  evidence?: Record<string, unknown>;
  sourceCreatorCountry?: string | null;
  targetMarketCountry?: string | null;
  locale?: string;
  nativeEvidenceStatus?: NativeEvidenceStatus | null;
  sourceProvenanceFamily?: SourceProvenanceFamily | null;
  sourceEvidenceId?: string;
  /**
   * Native v2 promotion eligibility supplied by the extraction caller. false
   * always wins; true still cannot override a failing current channel gate.
   * undefined preserves legacy observation behavior while the flag is
   * computed from current channel state.
   */
  promotionEligible?: boolean;
  /** Autonomous run/page that produced this observation, for exact novelty attribution. */
  queryRunId?: string;
  queryPageNumber?: number;
}, clientOverride?: Queryable): Promise<TerminologyObservationResult | null> {
  const canonical = args.term.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const normalized = normalizeTerm(canonical);
  const country = canonicalCountry(args.country);
  if (normalized.length < 2 || normalized.length > 80) return null;

  const isVideoBacked = Boolean(args.videoId && args.videoId.trim() !== '');
  const checksum = computeEvidenceChecksum(args.evidence);
  const hasEvidenceId = Boolean((args.sourceEvidenceId && args.sourceEvidenceId.trim() !== '') || checksum !== '');

  // For non-video observation types, fail closed if no stable source evidence identity is present
  if (!isVideoBacked && !hasEvidenceId && args.observationType !== 'CHANNEL_NAME') {
    return null;
  }

  const runner = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return null;

  // A Pool does not bind sequential queries to one connection. Own a transaction
  // so an observation, lifecycle refresh, and native projection either all
  // commit or all roll back; PoolClient/test runners continue directly.
  if ('connect' in runner && typeof (runner as Pool).connect === 'function' && !('release' in runner)) {
    const client = await (runner as Pool).connect();
    try {
      await client.query('BEGIN');
      const result = await observeTerminologyDetailed(args, client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  const contextLang = args.locale ? args.locale.split('-')[0] : args.language || 'und';
  const codeSwitching = detectCodeSwitching(canonical, contextLang);
  const weight = args.humanApproved ? 2.5 : args.observationType === 'ENRICHMENT' ? 1.25 : 1;

  // 1. Insert or fetch canonical trading term WITHOUT advancing last_observed_at on conflict.
  // A conflicting row keeps its timestamps; its language/script reconcile
  // forward only from unknown ('und'/empty) to a concrete provider language.
  // A concrete existing language always wins (first-writer-wins on conflict),
  // so ambiguous re-evidence can never overwrite an established language.
  //
  // Lock order: the advisory lock precedes EVERY row write below, including
  // this upsert. The reconcile UPDATE takes a real row lock, and lifecycle
  // refresh holds the advisory lock across its read phase before writing the
  // same row — upserting first would let an observer hold the row while
  // requesting the advisory lock the refresher holds (and vice versa), a
  // classic AB-BA deadlock PostgreSQL can only abort. A plain SELECT needs
  // no term id and takes no locks, so resolution starts lock-free; new-term
  // races arbitrate inside the upsert (unique/speculative waits hold no
  // advisory-relevant locks) before the winner proceeds to lock.
  const preexisting = await runner.query(
    `SELECT id FROM canonical_trading_terms WHERE country = $1 AND normalized_term = $2`,
    [country, normalized]
  );
  const preexistingId = preexisting.rows && preexisting.rows[0] ? Number(preexisting.rows[0].id) : null;
  if (preexistingId !== null) await acquireTerminologyLifecycleLock(preexistingId, runner);
  const saved = await runner.query(
    `INSERT INTO canonical_trading_terms(canonical_term, normalized_term, country, language, script, term_type, first_observed_at, last_observed_at)
     VALUES($1, $2, $3, $4, $5, $6, now(), now())
     ON CONFLICT(country, normalized_term) DO UPDATE SET language=EXCLUDED.language, script=EXCLUDED.script WHERE canonical_trading_terms.language IN ('und','')
     RETURNING id`,
    [canonical, normalized, country, contextLang, inferScript(canonical), args.termType]
  );

  let termId: number;
  if (saved.rows && saved.rows[0]) {
    termId = Number(saved.rows[0].id);
  } else {
    const existing = await runner.query(
      `SELECT id FROM canonical_trading_terms WHERE country = $1 AND normalized_term = $2`,
      [country, normalized]
    );
    if (!existing.rows || !existing.rows[0]) return null;
    termId = Number(existing.rows[0].id);
  }
  if (preexistingId === null) await acquireTerminologyLifecycleLock(termId, runner);

  // Lock order: advisory (acquired above, before any row write), then FOR
  // UPDATE, BEFORE the observation insert, recency update, and refresh below
  // (see acquireTerminologyLifecycleLock). Taking FOR UPDATE before any KEY
  // SHARE (observation/performance FK checks) is load-bearing: two concurrent
  // observers each holding KEY SHARE while requesting FOR UPDATE (e.g. inside
  // projection recomputation) deadlock, and either order with the upgrade
  // reversed reintroduces it. Re-entrant below: refresh re-acquires the
  // advisory harmlessly, and recomputation re-locks the already-held row.
  await runner.query(`SELECT id FROM canonical_trading_terms WHERE id=$1 FOR UPDATE`, [termId]);

  // 2. Resolve native creator/locale evidence status
  let resolvedCreatorCountry: string | null = args.sourceCreatorCountry ? canonicalCountry(args.sourceCreatorCountry) : null;
  let resolvedMarketCountry: string | null = args.targetMarketCountry ? canonicalCountry(args.targetMarketCountry) : null;
  let channelCountryStatus: string | null = null;
  let channelTradingStatus: string | null = null;
  let channelQualityScore = 0;

  if (!resolvedCreatorCountry && args.channelId) {
    const channelRes = await runner.query(
      `SELECT country, country_status, trading_status, quality_score FROM channels WHERE channel_id = $1`,
      [args.channelId]
    ).catch(() => ({ rows: [] }));

    if (channelRes.rows && channelRes.rows[0]) {
      const channelRow = channelRes.rows[0] as Record<string, unknown>;
      if (channelRow.country) resolvedCreatorCountry = canonicalCountry(String(channelRow.country));
      channelCountryStatus = channelRow.country_status ? String(channelRow.country_status) : null;
      channelTradingStatus = channelRow.trading_status ? String(channelRow.trading_status) : null;
      channelQualityScore = Number(channelRow.quality_score || 0);
    }
  } else if (args.channelId) {
    // Country was supplied explicitly; current channel gates still have to be
    // re-validated, so read the status/quality columns (never trust the caller
    // for promotion eligibility).
    const channelRes = await runner.query(
      `SELECT country_status, trading_status, quality_score FROM channels WHERE channel_id = $1`,
      [args.channelId]
    ).catch(() => ({ rows: [] }));
    if (channelRes.rows && channelRes.rows[0]) {
      const channelRow = channelRes.rows[0] as Record<string, unknown>;
      channelCountryStatus = channelRow.country_status ? String(channelRow.country_status) : null;
      channelTradingStatus = channelRow.trading_status ? String(channelRow.trading_status) : null;
      channelQualityScore = Number(channelRow.quality_score || 0);
    }
  }

  let resolvedNativeStatus: NativeEvidenceStatus | null = args.nativeEvidenceStatus || null;
  let resolvedProvenanceFamily: SourceProvenanceFamily | null = args.sourceProvenanceFamily || null;

  const sameCountryCreator = Boolean(resolvedCreatorCountry && resolvedCreatorCountry === country);
  const termLanguageMatchesContext = contextLang !== 'und' && codeSwitching.termLanguage === contextLang;
  // NATIVE_OBSERVED is an observation-classification fact (same country +
  // matching language), not a promotion fact. Existing callers that do not
  // supply a channel row keep legacy observation behavior; when a current
  // channel row exists, a LIKELY/UNCERTAIN country or unconfirmed trader
  // remains observation-only and is never mistaken for native evidence
  // (CDL §7.1).
  const nativeStatusEligible = Boolean(
    sameCountryCreator &&
    termLanguageMatchesContext &&
    (channelCountryStatus === null || channelCountryStatus === 'CONFIRMED') &&
    (channelTradingStatus === null || channelTradingStatus === 'TRADING_CONFIRMED')
  );
  if (!resolvedNativeStatus && nativeStatusEligible) {
    resolvedNativeStatus = 'NATIVE_OBSERVED';
    resolvedProvenanceFamily = 'CREATOR_METADATA';
  }
  // Promotion eligibility is a conjunction: the caller may only narrow the
  // current channel gate, never widen it. A stale caller true cannot survive
  // reclassification, quality decay, country drift, or code switching.
  const channelEligible = Boolean(
    args.channelId &&
    nativeStatusEligible &&
    channelCountryStatus === 'CONFIRMED' &&
    channelTradingStatus === 'TRADING_CONFIRMED' &&
    channelQualityScore >= 55
  );
  const promotionEligible = Boolean(args.promotionEligible ?? channelEligible)
    && channelEligible
    && resolvedNativeStatus === 'NATIVE_OBSERVED';

  // 3. Compute deterministic observation key for single-write idempotency.
  // Classification outcomes are excluded from identity (see
  // computeObservationKey): reclassification converges onto one row.
  const obsKey = computeObservationKey({
    canonicalTermId: termId,
    channelId: args.channelId,
    videoId: args.videoId,
    observationType: args.observationType,
    sourceEvidenceId: args.sourceEvidenceId,
    evidence: args.evidence
  });

  // 3b. Legacy reconciliation: rows keyed before the identity change (old
  // status-bearing keys, extractor-bearing checksums, or keyless rows) are
  // converged in place on first re-observation instead of duplicating.
  // Matching is by source identity plus evidence substance (recomputed with
  // the stored evidence): genuinely different evidence stays separate, while
  // any same-substance row — whatever its key vintage — heals onto the
  // current identity. The first match is rekeyed; further matches are
  // folded into its revision log and removed so aggregates count one row.
  // (One-time per row; the per-term advisory lock above serializes this.)
  const legacyCandidates = await runner.query(
    `SELECT id, observation_key, evidence, native_evidence_status, source_provenance_family,
            term_language, locale, observed_at
     FROM terminology_observations
     WHERE canonical_term_id=$1
       AND COALESCE(source_channel_id,'')=COALESCE($2::text,'')
       AND COALESCE(source_video_id,'')=COALESCE($3::text,'')
       AND observation_type=$4
       AND (observation_key IS NULL OR observation_key<>$5)
     ORDER BY observed_at ASC`,
    [termId, args.channelId || null, args.videoId || null, args.observationType, obsKey]
  );
  let convergedNewKeyId: number | null = null;
  // Set when reconciliation merges or removes rows (counts change): forces
  // the refresh below even if the main upsert is a no-op. Rekeys alone do
  // not set it — the subsequent upsert refreshes when anything changed.
  let legacyCountsChanged = false;
  {
    const newKeyHit = await runner.query(
      `SELECT id FROM terminology_observations WHERE observation_key=$1`, [obsKey]
    );
    if (newKeyHit.rows && newKeyHit.rows[0]) convergedNewKeyId = Number(newKeyHit.rows[0].id);
  }
  for (const row of (legacyCandidates.rows || []) as Array<Record<string, unknown>>) {
    // Same evidence substance under the current identity? Recompute this
    // row's key from its stored evidence: equality means same source. The
    // explicit sourceEvidenceId carries over: without it, an explicitly
    // identified re-observation could never match its prior row.
    const substanceKey = computeObservationKey({
      canonicalTermId: termId,
      channelId: args.channelId,
      videoId: args.videoId,
      observationType: args.observationType,
      sourceEvidenceId: args.sourceEvidenceId,
      evidence: (row.evidence || {}) as Record<string, unknown>
    });
    if (substanceKey !== obsKey) continue;
    if (convergedNewKeyId === null) {
      await runner.query(
        `UPDATE terminology_observations SET observation_key=$1 WHERE id=$2`, [obsKey, Number(row.id)]
      );
      convergedNewKeyId = Number(row.id);
    } else if (Number(row.id) !== convergedNewKeyId) {
      // Superseded residue: fold its classification into the surviving row's
      // revision log, then remove the duplicate. Observations are leaves
      // (no foreign keys reference them), so removal is safe. The entry is
      // serialized in JS and passed as one typed parameter: inline params
      // inside jsonb_build_object would have indeterminable types.
      const priorEvidence = (row.evidence || {}) as Record<string, unknown>;
      const { revisions: _priorRevisions, ...priorEvidenceFlat } = priorEvidence;
      const supersededEntry = JSON.stringify({
        observed_at: row.observed_at ?? null,
        native_evidence_status: row.native_evidence_status ?? null,
        source_provenance_family: row.source_provenance_family ?? null,
        term_language: row.term_language ?? null,
        locale: row.locale ?? null,
        superseded_legacy_key: row.observation_key ?? null,
        // Complete prior evidence payload (minus nested revisions) so the
        // removed row stays fully auditable: spans, extractor, quality flags.
        evidence: priorEvidenceFlat,
      });
      await runner.query(
        `UPDATE terminology_observations SET evidence = evidence || jsonb_build_object('revisions',
          COALESCE(evidence->'revisions', '[]'::jsonb) || jsonb_build_array($2::jsonb)
        ) WHERE id = $1`,
        [convergedNewKeyId, supersededEntry]
      );
      await runner.query(`DELETE FROM terminology_observations WHERE id=$1`, [Number(row.id)]);
      legacyCountsChanged = true;
    }
  }

  // 4. Perform single, authoritative observation write. Reclassification of
  // the same source converges: ON CONFLICT refreshes the volatile
  // classification columns (locale, languages, status, family, evidence) in
  // place instead of inserting a duplicate row, so projections never retain
  // stale native evidence. Identity columns (term, channel, video, type,
  // approvals, weight, community) are first-write-wins.
  const obsInsert = await runner.query(
    `INSERT INTO terminology_observations(
       canonical_term_id, source_channel_id, source_video_id, observation_type,
       human_approval_id, human_approved, community_fingerprint, evidence_weight, evidence,
       source_creator_country, target_market_country, locale, is_code_switched,
       native_language, term_language, native_evidence_status, source_provenance_family, code_switch_type,
       observation_key, promotion_eligible, query_run_id, query_page_number
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
     ON CONFLICT(observation_key) DO UPDATE SET
       locale=EXCLUDED.locale, is_code_switched=EXCLUDED.is_code_switched,
       native_language=EXCLUDED.native_language, term_language=EXCLUDED.term_language,
       native_evidence_status=EXCLUDED.native_evidence_status,
       source_provenance_family=EXCLUDED.source_provenance_family,
       source_creator_country=EXCLUDED.source_creator_country,
       target_market_country=EXCLUDED.target_market_country,
       code_switch_type=EXCLUDED.code_switch_type,
       promotion_eligible=EXCLUDED.promotion_eligible,
       -- First attribution wins; a later replay of the same evidence can fill
       -- provenance that a legacy writer left NULL but never steal it.
       query_run_id=COALESCE(terminology_observations.query_run_id, EXCLUDED.query_run_id),
       query_page_number=COALESCE(terminology_observations.query_page_number, EXCLUDED.query_page_number),
       -- Audit trail: the superseded classification is appended to an
       -- in-evidence revision log (no schema change) instead of being lost.
       -- Quality rollups read only top-level keys and are unaffected.
       evidence = EXCLUDED.evidence || jsonb_build_object('revisions',
         COALESCE(terminology_observations.evidence->'revisions', '[]'::jsonb) || jsonb_build_object(
           'observed_at', terminology_observations.observed_at,
           'native_evidence_status', terminology_observations.native_evidence_status,
           'source_provenance_family', terminology_observations.source_provenance_family,
           'promotion_eligible', terminology_observations.promotion_eligible,
           'term_language', terminology_observations.term_language,
           'locale', terminology_observations.locale,
           -- Complete prior evidence payload (minus nested revisions) so the
           -- superseded version stays fully auditable: source spans,
           -- extractor details, and quality flags are all preserved.
           'evidence', terminology_observations.evidence - 'revisions'
         )
       )
     -- No-op when nothing material changed: identical re-observations skip
     -- the write (and the refresh below), so replays stay cheap and the
     -- revision log grows only on genuine reclassification.
     WHERE terminology_observations.native_evidence_status IS DISTINCT FROM EXCLUDED.native_evidence_status
        OR terminology_observations.source_provenance_family IS DISTINCT FROM EXCLUDED.source_provenance_family
        OR terminology_observations.promotion_eligible IS DISTINCT FROM EXCLUDED.promotion_eligible
        OR terminology_observations.term_language IS DISTINCT FROM EXCLUDED.term_language
        OR terminology_observations.is_code_switched IS DISTINCT FROM EXCLUDED.is_code_switched
        OR terminology_observations.code_switch_type IS DISTINCT FROM EXCLUDED.code_switch_type
        OR terminology_observations.locale IS DISTINCT FROM EXCLUDED.locale
        OR terminology_observations.source_creator_country IS DISTINCT FROM EXCLUDED.source_creator_country
        OR terminology_observations.target_market_country IS DISTINCT FROM EXCLUDED.target_market_country
        OR (terminology_observations.evidence->>'spamConfirmed') IS DISTINCT FROM (EXCLUDED.evidence->>'spamConfirmed')
        -- Any other evidence-substance change (novelty flips, generic flags,
        -- spam-signal or translation-risk updates, extractor-label aside):
        -- without this, re-observations that only change quality metadata
        -- would skip the update and leave stale rollup inputs in place.
        -- Revisions bookkeeping is excluded (it always differs post-update).
        OR ((terminology_observations.evidence - 'revisions') IS DISTINCT FROM (EXCLUDED.evidence - 'revisions'))
     RETURNING id, observed_at, (xmax = 0) AS inserted`,
    [
      termId,
      args.channelId || null,
      args.videoId || null,
      args.observationType,
      args.humanApprovalId || null,
      Boolean(args.humanApproved),
      args.communityFingerprint || null,
      weight,
      JSON.stringify(args.evidence || {}),
      resolvedCreatorCountry,
      resolvedMarketCountry,
      args.locale || args.language || 'und',
      codeSwitching.isCodeSwitched,
      codeSwitching.dominantLanguage, // Context / native language (e.g. de)
      codeSwitching.termLanguage,     // Embedded term language (e.g. en)
      resolvedNativeStatus,           // NATIVE_OBSERVED | BOOTSTRAP_SEED | TRANSLATED_SEED | NULL
      resolvedProvenanceFamily,
      codeSwitching.codeSwitchType,
      obsKey,
      promotionEligible,
      args.queryRunId || null,
      Number.isFinite(args.queryPageNumber) ? Math.max(1, Math.trunc(args.queryPageNumber as number)) : null,
    ]
  );

  // 5. Invoke authoritative terminology lifecycle refresh & projection
  // recompute on insert AND on reclassification-update (a status change can
  // promote, demote, or revoke eligibility). last_observed_at advances only
  // on insert. (xmax = 0) is true solely for freshly inserted rows; the
  // per-term advisory lock above excludes concurrent modifiers.
  const writtenRow = (obsInsert.rows && obsInsert.rows[0]) || null;
  const observationInserted = writtenRow?.inserted === true;
  if (observationInserted && writtenRow) {
    const obsAt = writtenRow.observed_at || new Date().toISOString();
    await runner.query(
      `UPDATE canonical_trading_terms
       SET last_observed_at = GREATEST(last_observed_at, $2)
       WHERE id = $1`,
      [termId, obsAt]
    );
  }
  if (writtenRow || legacyCountsChanged) {
    await refreshTerminologyLifecycle(termId, DEFAULT_TERMINOLOGY_POLICY, runner);
    await recomputeNativeEvidenceProjection(termId, runner);
  }

  return { termId, observationInserted };
}

/**
 * Stable public contract: canonical term id or null. Callers that need to
 * know whether the observation row was newly inserted (e.g. to gate
 * extracted-vocabulary occurrence increments) use observeTerminologyDetailed.
 */
export async function observeTerminology(
  args: Parameters<typeof observeTerminologyDetailed>[0],
  clientOverride?: Queryable
): Promise<number | null> {
  const result = await observeTerminologyDetailed(args, clientOverride);
  return result ? result.termId : null;
}

export async function addTerminologyAlias(canonicalTermId: number, alias: string, aliasType: 'ABBREVIATION' | 'SPELLING' | 'TRANSLITERATION' | 'SHORTHAND' | 'REGIONAL' | 'SPELLING_VARIANT', language = 'und', clientOverride?: Queryable): Promise<void> {
  const normalized = normalizeTerm(alias);
  if (normalized.length < 2) return;
  const runner = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return;
  await runner.query(`INSERT INTO trading_term_aliases(canonical_term_id,alias,normalized_alias,language,script,alias_type) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(canonical_term_id,normalized_alias) DO NOTHING`, [canonicalTermId, alias.normalize('NFKC').trim(), normalized, language, inferScript(alias), aliasType]);
}

/**
 * Version-skew limitation (documented, not fixable in application code): the
 * native-v1 trial-entry gate below binds only workers running this code. An
 * older worker sharing the database applies decideLifecycle without the gate
 * and can mark a term search-eligible while a native observation is in flight.
 * No application-level mechanism constrains another binary; a
 * version-independent database enforcement would require a DDL migration,
 * which is out of scope for this change. Operational mitigation: the fleet
 * deploys a single version at a time, no native-v1 observations exist until
 * this code ships, and terminology-driven selection stays inactive until the
 * E2E staging proof passes — so the gate and the first native-v1 writes
 * always land on a single-version fleet.
 */
async function readCdlTerminologyFlags(runner: Queryable): Promise<{ cdl: boolean; v2: boolean }> {
  const result = await runner.query(
    `SELECT setting_key, setting_value FROM app_settings WHERE setting_key = ANY($1)`,
    [['country_discovery_loop_enabled', 'native_evidence_promotion_v2_enabled']],
  ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
  const values = new Map<string, string>((result.rows || []).map((row: Record<string, unknown>) => [
    String(row.setting_key),
    String(row.setting_value),
  ]));
  return {
    cdl: values.get('country_discovery_loop_enabled') === 'true',
    v2: values.get('native_evidence_promotion_v2_enabled') === 'true',
  };
}

async function readExternalTermEvidence(
  runner: Queryable,
  termId: number,
  term: Record<string, unknown>
): Promise<ExternalTermEvidenceResult> {
  const aliases = await runner.query(
    `SELECT normalized_alias FROM trading_term_aliases WHERE canonical_term_id=$1`,
    [termId],
  ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
  // Match the term and its governed aliases in SQL before the LIMIT. Filtering
  // only in JavaScript after a country-wide LIMIT can drop valid corroboration
  // when a country has more than 1,000 newer external rows for other terms.
  // The SQL normalization mirrors normalizeTerm (NFKC, whitespace collapse,
  // trim, lowercase), so the index remains usable and the JS re-check stays.
  const targetSurfaces = [...new Set(
    [term.canonical_term, ...(aliases.rows || []).map(row => row.normalized_alias)]
      .map(value => normalizeTerm(String(value || '')))
      .filter(Boolean),
  )];
  const rows = targetSurfaces.length === 0
    ? { rows: [] as Array<Record<string, unknown>> }
    : await runner.query(
      `SELECT source_id, source_family, correlation_key, observed_at, confidence, reliability, relevance,
              original_surface, language, script
       FROM external_osint_observations
       WHERE country=$1
         AND observed_at >= now() - interval '30 days'
         AND lower(btrim(regexp_replace(normalize(original_surface, NFKC), '[[:space:]]+', ' ', 'g'))) = ANY($2::text[])
       ORDER BY observed_at DESC LIMIT 1000`,
      [term.country, targetSurfaces],
    ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
  return evaluateExternalTermEvidence({
    term: String(term.canonical_term || ''),
    aliases: (aliases.rows || []).map(row => String(row.normalized_alias || '')),
    language: term.language ? String(term.language) : null,
    script: term.script ? String(term.script) : null,
    rows: (rows.rows || []).map(row => ({
      sourceId: String(row.source_id || ''),
      sourceFamily: String(row.source_family || ''),
      correlationKey: row.correlation_key ? String(row.correlation_key) : null,
      observedAt: String(row.observed_at || ''),
      confidence: Number(row.confidence || 0),
      reliability: Number(row.reliability || 0),
      relevance: Number(row.relevance || 0),
      surface: String(row.original_surface || ''),
      language: String(row.language || ''),
      script: String(row.script || ''),
    })),
  });
}

export async function refreshTerminologyLifecycle(termId: number, policy = DEFAULT_TERMINOLOGY_POLICY, clientOverride?: Queryable): Promise<void> {
  const runner = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return;
  // A Pool does not bind sequential queries to one connection: own a
  // transaction exactly like observeTerminology does, so the row lock below
  // actually serializes concurrent refreshes instead of releasing instantly.
  if ('connect' in runner && typeof (runner as Pool).connect === 'function' && !('release' in runner)) {
    const client = await (runner as Pool).connect();
    try {
      await client.query('BEGIN');
      await refreshTerminologyLifecycle(termId, policy, client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return;
  }
  // Per-term serialization WITHOUT row-lock upgrade hazards: an advisory
  // transaction lock on the term, taken BEFORE reading aggregates and quality
  // evidence. A concurrent refresh (or an in-flight observation/attribution
  // transaction, which refreshes inside its own transaction) then waits for
  // this transaction's committed state instead of deciding on pre-commit
  // reads — every transition evaluates committed evidence under the same
  // serialization, and block-event check-and-insert becomes atomic with the
  // refresh. A row lock (FOR UPDATE) is deliberately NOT used here: both
  // observation and performance inserts hold FOR KEY SHARE on the term row
  // via their canonical_term_id foreign keys until commit, and two
  // transactions upgrading KEY SHARE -> FOR UPDATE on the same term deadlock.
  // FOR NO KEY UPDATE would avoid the deadlock but is compatible with KEY
  // SHARE, so it would not wait for uncommitted observations and would
  // reintroduce the pre-commit-read race. The advisory lock (separate lock
  // namespace, one lock per refresh, always acquired first) serializes with
  // neither hazard. Namespace follows the codebase hashtext($1) convention.
  await runner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`terminology-lifecycle:${termId}`]);
  const flags = await readCdlTerminologyFlags(runner);
  const v2Enabled = flags.cdl && flags.v2;
  const result = await runner.query(`SELECT t.*, COALESCE(o.distinct_creators,0)::int distinct_creators, COALESCE(o.distinct_communities,0)::int distinct_communities,
    COALESCE(o.human_approved,0)::int human_approved, COALESCE(o.decayed_evidence,0)::float decayed_evidence,
    COALESCE(p.executions,0)::int executions, COALESCE(p.decayed_yield,0)::float decayed_yield
    FROM canonical_trading_terms t LEFT JOIN LATERAL (SELECT COUNT(DISTINCT source_channel_id) FILTER (WHERE source_channel_id IS NOT NULL) distinct_creators,
      COUNT(DISTINCT community_fingerprint) FILTER (WHERE community_fingerprint IS NOT NULL) distinct_communities, COUNT(DISTINCT source_channel_id) FILTER (WHERE human_approved) human_approved,
      SUM(evidence_weight * power(0.5, EXTRACT(EPOCH FROM (now()-observed_at))/86400/$2)) decayed_evidence FROM terminology_observations WHERE canonical_term_id=t.id) o ON true
    LEFT JOIN LATERAL (SELECT COALESCE(SUM(executions),0) executions, COALESCE(SUM(decayed_yield_score*executions)/NULLIF(SUM(executions),0),0) decayed_yield FROM terminology_performance WHERE canonical_term_id=t.id) p ON true WHERE t.id=$1`, [termId, policy.halfLifeDays]);
  if (!result.rows[0]) return;
  const row = result.rows[0];
  let decision = decideLifecycle({ current: row.lifecycle_status, decayedEvidence: row.decayed_evidence, distinctCreators: row.distinct_creators, distinctCommunities: row.distinct_communities, executions: row.executions, decayedYield: row.decayed_yield, termType: row.term_type }, policy);
  let v2Snapshot: Record<string, unknown> | null = null;
  if (v2Enabled) {
    // C2 current-state reconciliation. A channel reclassified away from the
    // term's country (or no longer CONFIRMED / TRADING_CONFIRMED / quality>=55,
    // or no longer a native literal observation) must not leave a historical
    // promotion_eligible=true flag behind. The aggregate below already
    // re-validates current state and excludes these rows; clearing the stored
    // flag keeps audit/projection truth consistent and prevents a later
    // flag-only read from treating stale evidence as promotable. This is
    // idempotent (the predicate is false once cleared).
    await runner.query(
      `UPDATE terminology_observations o
       SET promotion_eligible=false
       FROM channels c
       WHERE o.canonical_term_id=$1
         AND o.promotion_eligible=true
         AND c.channel_id=o.source_channel_id
         AND (
           c.country_status IS DISTINCT FROM 'CONFIRMED'
           OR c.trading_status IS DISTINCT FROM 'TRADING_CONFIRMED'
           OR COALESCE(c.quality_score,0) < 55
           OR c.country IS NULL
           OR lower(c.country) <> lower($2)
           OR o.source_creator_country IS NULL
           OR lower(o.source_creator_country) <> lower($2)
           OR o.native_evidence_status IS DISTINCT FROM 'NATIVE_OBSERVED'
           OR o.source_provenance_family IS DISTINCT FROM 'CREATOR_METADATA'
           OR o.is_code_switched=true
           OR (
             o.term_language IS NOT NULL
             AND o.term_language NOT IN ('und','')
             AND lower(o.term_language) <> lower($3)
           )
         )`,
      [termId, row.country, row.language || 'und'],
    );
    const v2Aggregate = await runner.query(
      `SELECT
         COUNT(DISTINCT o.source_channel_id) FILTER (WHERE o.source_channel_id IS NOT NULL)::int AS native_creators,
         COUNT(DISTINCT COALESCE(NULLIF(o.community_fingerprint,''), o.source_channel_id)) FILTER (WHERE o.source_channel_id IS NOT NULL)::int AS native_evidence_buckets,
         COUNT(DISTINCT o.community_fingerprint) FILTER (WHERE o.community_fingerprint IS NOT NULL)::int AS distinct_communities,
         COUNT(DISTINCT o.source_channel_id) FILTER (WHERE o.human_approved)::int AS human_approved,
         COALESCE(SUM(o.evidence_weight * power(0.5, EXTRACT(EPOCH FROM (now()-o.observed_at))/86400/$3)),0)::float AS decayed_evidence
       FROM terminology_observations o
       JOIN channels c ON c.channel_id = o.source_channel_id
       WHERE o.canonical_term_id=$1
         AND o.promotion_eligible=true
         AND o.native_evidence_status='NATIVE_OBSERVED'
         AND o.source_provenance_family='CREATOR_METADATA'
         AND c.country_status='CONFIRMED'
         AND c.trading_status='TRADING_CONFIRMED'
         AND COALESCE(c.quality_score,0)>=55
         AND c.country=$2
         AND o.source_creator_country=$2
         AND o.is_code_switched=false
         -- NULL means the writer did not record a term language; the demotion
         -- query and migration backfill treat it as eligible, so the aggregate
         -- must too or v2 promotions can never count legacy native evidence.
         AND (o.term_language IS NULL OR o.term_language=$4 OR $4 IN ('und','') OR o.term_language IN ('und',''))`,
      [termId, row.country, policy.halfLifeDays, row.language || 'und'],
    );
    const v2Row = ((v2Aggregate.rows || [])[0] || {}) as Record<string, unknown>;
    const external = await readExternalTermEvidence(runner, termId, row as Record<string, unknown>);
    const perf = await runner.query(
      `SELECT COALESCE(SUM(executions),0)::int executions, COALESCE(SUM(quota_consumed),0)::int quota,
        COALESCE(SUM(confirmed_trading_creators),0)::int confirmed, COALESCE(SUM(non_trading_creators),0)::int nontrading,
        COALESCE(SUM(wrong_country_creators),0)::int wrong, COALESCE(SUM(needs_review_creators),0)::int review,
        COALESCE(SUM(new_creators),0)::int fresh
       FROM terminology_performance WHERE canonical_term_id=$1`,
      [termId],
    );
    const perfRow = ((perf.rows || [])[0] || {}) as Record<string, unknown>;
    // confirmed_trading_creators counts repeat sightings too. Bound the v2
    // promotion input by persisted new creators, exactly like the legacy gate:
    // repeat-only runs with zero newly verified traders must not promote.
    const freshConfirmed = Math.min(Number(perfRow.confirmed || 0), Number(perfRow.fresh || 0));
    const nativeCreators = Number(v2Row.native_creators || 0);
    const nativeEvidenceBuckets = Number(v2Row.native_evidence_buckets || nativeCreators);
    row.distinct_creators = nativeCreators;
    row.distinct_communities = Number(v2Row.distinct_communities || 0);
    row.human_approved = Number(v2Row.human_approved || 0);
    row.decayed_evidence = Number(v2Row.decayed_evidence || 0);
    row.executions = Number(perfRow.executions || row.executions || 0);
    v2Snapshot = {
      nativeCreators,
      nativeEvidenceBuckets,
      externalSources: external.independentSources,
      externalEligible: external.eligible,
      externalTrialEvidenceScore: external.independentSources,
      externalFamilies: external.families,
      externalReasons: external.reasons,
      confirmedTradingCreators: freshConfirmed,
      wrongCountryCreators: Number(perfRow.wrong || 0),
      needsReviewCreators: Number(perfRow.review || 0),
      quotaConsumed: Number(perfRow.quota || 0),
    };
    decision = decideLifecycleV2({
      current: row.lifecycle_status,
      termType: row.term_type,
      decayedEvidence: row.decayed_evidence,
      nativeCreators,
      nativeEvidenceBuckets,
      externalSources: external.independentSources,
      externalSourceCount: external.independentSources,
      externalEligible: external.eligible,
      externalTrialEvidenceScore: external.independentSources,
      confirmedTradingCreators: freshConfirmed,
      nonTradingCreators: Number(perfRow.nontrading || 0),
      wrongCountryCreators: Number(perfRow.wrong || 0),
      needsReviewCreators: Number(perfRow.review || 0),
      executions: Number(perfRow.executions || 0),
      decayedYield: Number(row.decayed_yield || 0),
      quotaConsumed: Number(perfRow.quota || 0),
    }, policy);
  }
  // Native quality gate: applies whenever the term carries new-pipeline
  // (qualityVersion) evidence, whether entering eligibility or already
  // eligible. Legacy-only terms take the legacy path below byte-identically.
  // Spam or non-novel terms are held with a recorded reason instead of
  // entering trial/proven states — and an already-eligible term whose native
  // evidence denies entry is revoked (search_eligible=false, status
  // otherwise untouched unless legacy rules demote). Without revocation, an
  // attribution refresh could mark a term eligible while a native
  // observation is uncommitted, and the later observation refresh would skip
  // the gate (already eligible) and leave the ineligible term eligible.
  // Demotion stays yield-driven. The quality rollup is read once; per-term
  // serialization makes re-reads unnecessary.
  let qualityBlocked = false;
  // Actual persisted lifecycle_status when blocked (entry block preserves the
  // row status; revoke preserves it too unless legacy rules demote).
  let blockedStatus: string | null = null;
  const enteringEligibility = !row.search_eligible && decision.searchEligible;
  // The gate below acts only when legacy keeps/grants eligibility or the row
  // already has it; otherwise the outcome is the legacy path regardless, so
  // the aggregate read is skipped (identical outcome, no wasted query). A
  // PROVEN legacy decision always sets searchEligible, so the PROVEN cap
  // below never faces a skipped read.
  const quality = (enteringEligibility || row.search_eligible)
    ? await readNativeQualityEvidence(termId, runner, v2Enabled ? NATIVE_QUALITY_ROLLUP_V2_SQL : NATIVE_QUALITY_ROLLUP_SQL)
    : { v1Observations: 0, spamConfirmed: false, novel: false };
  // Native PROVEN gate: the legacy lifecycle must not automatically mark a
  // native-v1 term PROVEN on executions/yield alone (scopeWeightedYield counts
  // in-scope channels regardless of trading outcome). Promotion to PROVEN
  // requires the native policy's verified-trader bar, evaluated here from the
  // persisted performance ledger; otherwise the term is capped at SEARCH_TRIAL
  // (still search-eligible, still trialed). Already-PROVEN rows are left
  // untouched — only new promotions are gated. coordinatedBurst has no stored
  // signal, so burst review stays operator-side (conservative: absent).
  let effectiveDecision = decision;
  // New promotions only: an already-PROVEN row keeps its status (and trust
  // tier) even when current performance would not clear the bar fresh —
  // downgrades stay exclusively yield-driven via DEMOTED.
  if (!v2Enabled && decision.status === 'PROVEN_SEARCH_TERM' && row.lifecycle_status !== 'PROVEN_SEARCH_TERM' && quality.v1Observations > 0) {
    const perf = await runner.query(
      `SELECT COALESCE(SUM(executions),0)::int executions, COALESCE(SUM(quota_consumed),0)::int quota,
        COALESCE(SUM(confirmed_trading_creators),0)::int confirmed, COALESCE(SUM(non_trading_creators),0)::int nontrading,
        COALESCE(SUM(wrong_country_creators),0)::int wrong, COALESCE(SUM(needs_review_creators),0)::int review,
        COALESCE(SUM(new_creators),0)::int fresh
       FROM terminology_performance WHERE canonical_term_id=$1`,
      [termId]
    );
    const agg = ((perf.rows || [])[0] || {}) as Record<string, unknown>;
    // Verified-trader bar counts FRESH discoveries only: confirmed_trading_creators
    // tallies every TRADING_CONFIRMED funnel result including repeat sightings
    // of already-known traders, so repeat-only runs could clear the bar with
    // zero newly verified traders. Bounding by persisted new creators (a sound
    // upper bound — every newly verified trader is a new channel) closes that
    // without a schema change. No fresh-new breakdown exists per bucket, so
    // the other buckets keep their stored totals (conservative direction kept:
    // under-counting fresh confirmations can only HOLD, never wrongly promote).
    const freshConfirmed = Math.min(Number(agg.confirmed || 0), Number(agg.fresh || 0));
    const verdict = evaluateNativeTermPromotion({
      novel: quality.novel,
      spamConfirmed: quality.spamConfirmed,
      executions: Number(agg.executions || 0),
      quotaConsumed: Number(agg.quota || 0),
      confirmedTradingCreators: freshConfirmed,
      nonTradingCreators: Number(agg.nontrading || 0),
      wrongCountryCreators: Number(agg.wrong || 0),
      needsReviewCreators: Number(agg.review || 0),
      distinctCreators: row.distinct_creators,
      distinctCommunities: row.distinct_communities,
      coordinatedBurst: false,
    });
    if (verdict.decision !== 'PROMOTE') {
      effectiveDecision = {
        status: 'SEARCH_TRIAL',
        searchEligible: true,
        reason: `native promotion bar not met (${verdict.decision}): ${verdict.reasons.join('; ')}`,
      };
    }
  }
  if (quality.v1Observations > 0) {
    const entry = evaluateTrialEntry({ novel: quality.novel, spamConfirmed: quality.spamConfirmed });
    if (!entry.allowed) {
      if (effectiveDecision.searchEligible || row.search_eligible) {
        qualityBlocked = true;
        const demoteFollows = row.search_eligible && effectiveDecision.status === 'DEMOTED';
        // event_type is CHECK-constrained to PROMOTION/DEMOTION/ELIGIBILITY_CHANGE.
        const blockReason = row.search_eligible && effectiveDecision.searchEligible && !demoteFollows
          ? `quality-gate revoked eligibility: ${entry.reasons.join('; ')}`
          : `quality-gate blocked trial entry: ${entry.reasons.join('; ')}`;
        const eventType = demoteFollows ? 'DEMOTION' : 'ELIGIBILITY_CHANGE';
        const eventTo = demoteFollows ? decision.status : row.lifecycle_status;
        if (row.search_eligible) {
          // Revoke: strip eligibility the legacy decision would keep. Status
          // follows legacy demotion when the legacy decision demotes (still
          // yield-driven); otherwise the status is preserved untouched.
          blockedStatus = eventTo;
          await runner.query(
            'UPDATE canonical_trading_terms SET lifecycle_status=$2,search_eligible=false,trust_tier=$3 WHERE id=$1',
            [termId, eventTo, demoteFollows ? (effectiveDecision.searchEligible ? 2 : 3) : row.trust_tier]
          );
        } else {
          blockedStatus = row.lifecycle_status;
        }
        // Idempotency: a term that stays blocked for the same reason must not
        // append a duplicate event on every refresh — record only when the
        // (type, reason) changed since the latest event.
        const latest = await runner.query(
          `SELECT event_type, reason FROM terminology_lifecycle_events WHERE canonical_term_id=$1 ORDER BY id DESC LIMIT 1`,
          [termId]
        );
        const lastEvent = ((latest.rows || [])[0] || {}) as Record<string, unknown>;
        if (!(lastEvent.event_type === eventType && lastEvent.reason === blockReason)) {
          await runner.query(
            `INSERT INTO terminology_lifecycle_events(canonical_term_id,from_status,to_status,event_type,reason,evidence_snapshot) VALUES($1,$2,$3,$4,$5,$6)`,
            [termId, row.lifecycle_status, eventTo, eventType, blockReason, JSON.stringify({ v1Observations: quality.v1Observations, novel: quality.novel, spamConfirmed: quality.spamConfirmed, ...(v2Snapshot || {}) })]
          );
        }
      }
    }
  }
  if (!qualityBlocked && (effectiveDecision.status !== row.lifecycle_status || effectiveDecision.searchEligible !== row.search_eligible)) {
    await runner.query('UPDATE canonical_trading_terms SET lifecycle_status=$2,search_eligible=$3,trust_tier=$4 WHERE id=$1', [termId, effectiveDecision.status, effectiveDecision.searchEligible, effectiveDecision.status === 'PROVEN_SEARCH_TERM' ? 1 : effectiveDecision.searchEligible ? 2 : 3]);
    await runner.query(`INSERT INTO terminology_lifecycle_events(canonical_term_id,from_status,to_status,event_type,reason,evidence_snapshot) VALUES($1,$2,$3,$4,$5,$6)`, [termId, row.lifecycle_status, effectiveDecision.status, effectiveDecision.status === 'DEMOTED' ? 'DEMOTION' : 'PROMOTION', effectiveDecision.reason, JSON.stringify({ distinctCreators: row.distinct_creators, distinctCommunities: row.distinct_communities, executions: row.executions, decayedEvidence: row.decayed_evidence, decayedYield: row.decayed_yield, ...(v2Snapshot || {}) })]);
  }
  // The snapshot records the persisted lifecycle state: when the quality
  // gate blocks a transition, decision.status was never applied.
  await runner.query(`INSERT INTO terminology_score_snapshots(canonical_term_id,distinct_creators,distinct_communities,human_approved_creators,decayed_evidence,decayed_yield_score,lifecycle_status,configuration) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [termId, row.distinct_creators, row.distinct_communities, row.human_approved, row.decayed_evidence, row.decayed_yield, qualityBlocked ? (blockedStatus ?? row.lifecycle_status) : effectiveDecision.status, JSON.stringify(policy)]);
}

/**
 * Scope-weighted terminology yield: out-of-scope fresh channels earn no
 * learning credit. Absent scope data (legacy callers) falls back to the
 * unweighted yield, preserving historical behavior exactly.
 */
export function scopeWeightedYield(
  distinctResults: number,
  newChannels: number,
  inScopeNewChannels?: number,
): number {
  if (!distinctResults) return 0;
  return (inScopeNewChannels ?? newChannels) / distinctResults;
}

export async function attributeTerminologyPerformance(query: QueryRecord, metrics: QueryFunnelMetrics, quotaConsumed = 0, retrievalLane?: string, searchOrdering?: string, clientOverride?: Queryable): Promise<void> {
  const metadata = query.generation_metadata || {};
  const learned = typeof metadata.learnedTerm === 'string' ? normalizeTerm(metadata.learnedTerm) : null;
  if (!learned) return;
  const runner = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return;
  // Same Pool discipline as observe/refresh: the advisory lock, the
  // performance insert, and the lifecycle refresh must share one transaction-
  // bound client, or the lock releases before the protected writes.
  if ('connect' in runner && typeof (runner as Pool).connect === 'function' && !('release' in runner)) {
    const client = await (runner as Pool).connect();
    try {
      await client.query('BEGIN');
      await attributeTerminologyPerformance(query, metrics, quotaConsumed, retrievalLane, searchOrdering, client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return;
  }
  const terms = await runner.query('SELECT id FROM canonical_trading_terms WHERE country=$1 AND normalized_term=$2', [canonicalCountry(query.country), learned]);
  for (const row of terms.rows) {
    // Lock order: advisory BEFORE the performance insert below (its FK takes
    // KEY SHARE on the term row). Matches observe/refresh ordering.
    await acquireTerminologyLifecycleLock(Number(row.id), runner);
    const yieldScore = scopeWeightedYield(metrics.distinctResults, metrics.newChannels, metrics.inScopeNewChannels);
    await runner.query(`INSERT INTO terminology_performance(canonical_term_id,query_id,retrieval_lane,search_ordering,raw_results,unique_creators,new_creators,confirmed_trading_creators,needs_review_creators,non_trading_creators,wrong_country_creators,communities_discovered,quota_consumed,decayed_yield_score) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [row.id, query.id, String(retrievalLane || metadata.retrievalLane || 'UNKNOWN'), String(searchOrdering || metadata.searchOrdering || 'RELEVANCE'), metrics.rawResults, metrics.distinctResults, metrics.newChannels, metrics.tradingConfirmed, metrics.needsReview, metrics.nonTrading, metrics.countryRejected, metrics.communitiesDiscovered, quotaConsumed, yieldScore]);
    await refreshTerminologyLifecycle(Number(row.id), DEFAULT_TERMINOLOGY_POLICY, runner);
  }
}

export async function getTerminologyDashboard(country?: string, clientOverride?: Queryable): Promise<unknown[]> {
  const runner = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return [];
  const result = await runner.query(`SELECT t.*, COALESCE(a.aliases,'[]'::json) aliases, COALESCE(o.distinct_creators,0)::int distinct_creator_count,
    COALESCE(p.executions,0)::int executions, COALESCE(p.new_creators,0)::int new_creators, COALESCE(p.decayed_yield_score,0)::float decayed_yield_score,
    COALESCE(p.lanes,'{}'::json) retrieval_lanes, COALESCE(e.history,'[]'::json) lifecycle_history
    FROM canonical_trading_terms t
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('alias',alias,'type',alias_type,'language',language,'script',script)) aliases FROM trading_term_aliases WHERE canonical_term_id=t.id) a ON true
    LEFT JOIN LATERAL (SELECT COUNT(DISTINCT source_channel_id) distinct_creators FROM terminology_observations WHERE canonical_term_id=t.id) o ON true
    LEFT JOIN LATERAL (SELECT SUM(executions) executions,SUM(new_creators) new_creators,COALESCE(SUM(weighted_yield_total)/NULLIF(SUM(executions),0),0) decayed_yield_score,json_object_agg(retrieval_lane,lane_yield) lanes FROM (SELECT retrieval_lane,SUM(executions) executions,SUM(new_creators) new_creators,SUM(decayed_yield_score*executions) weighted_yield_total,AVG(decayed_yield_score) lane_yield FROM terminology_performance WHERE canonical_term_id=t.id GROUP BY retrieval_lane) x) p ON true
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('type',event_type,'from',from_status,'to',to_status,'reason',reason,'at',created_at) ORDER BY created_at DESC) history FROM terminology_lifecycle_events WHERE canonical_term_id=t.id) e ON true
    WHERE ($1::text IS NULL OR t.country=$1) ORDER BY t.search_eligible DESC,p.decayed_yield_score DESC,t.last_observed_at DESC NULLS LAST`, [country ? canonicalCountry(country) : null]);
  return result.rows;
}

export async function getPlannerTerminology(country: string, clientOverride?: Queryable, deps?: { isKillSwitchActive?: () => Promise<boolean> }): Promise<Array<{ id: number; term: string; score: number; lifecycle: 'SEARCH_TRIAL' | 'PROVEN_SEARCH_TERM' }>> {
  const runner = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return [];
  // Planner-path kill switch: while active the planner sees no trial/proven
  // terminology atoms at all, so the serving loop stops without touching
  // eligibility data (search_eligible / lifecycle rows stay intact and the
  // stop lifts the moment the setting is cleared). Callers that supplied
  // their own client read the setting through that same client, so tooling
  // that avoids the app pool (migrations/seed bootstrap) keeps avoiding it.
  const isActive = deps?.isKillSwitchActive
    ?? (clientOverride ? () => isTerminologyKillSwitchActiveOn(clientOverride) : isTerminologyKillSwitchActive);
  if (await isActive()) return [];
  const result = await runner.query(`SELECT t.id,t.canonical_term term,t.lifecycle_status,COALESCE(AVG(p.decayed_yield_score),0)::float score FROM canonical_trading_terms t LEFT JOIN terminology_performance p ON p.canonical_term_id=t.id WHERE t.country=$1 AND t.search_eligible=true AND t.lifecycle_status IN ('SEARCH_TRIAL','PROVEN_SEARCH_TERM') GROUP BY t.id ORDER BY score DESC,t.last_observed_at DESC NULLS LAST LIMIT 50`, [canonicalCountry(country)]);
  return result.rows.map(row => ({ id: Number(row.id), term: row.term, score: Number(row.score), lifecycle: row.lifecycle_status as 'SEARCH_TRIAL' | 'PROVEN_SEARCH_TERM' }));
}
