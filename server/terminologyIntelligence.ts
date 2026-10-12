import type { Pool, PoolClient } from 'pg';
import type { CountryVocabulary, QueryRecord } from '../src/types';
import type { QueryFunnelMetrics } from './queryPerformance';
import { getDb } from './db';
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
  const hasNonLatin = /[^\u0000-\u024F\u1E00-\u1EFF]/u.test(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Boundaries guard against Latin-script letters only: 'ES' inside 'heroes'
  // is a fragment, but CJK and similar scripts have no word boundaries, so an
  // instrument adjacent to Han/Hangul/etc. characters still matches.
  const body = hasNonLatin ? escaped : `(?<!\\p{Script=Latin})${escaped}(?!\\p{Script=Latin})`;
  // Case-insensitive matching is left to the regex engine ('iu'), which folds
  // case per character without changing string lengths — lowercasing both
  // sides first (e.g. Turkish İ → i̇) would shift offsets and corrupt spans.
  const pattern = new RegExp(body, 'iu');
  for (const source of sources) {
    if (!source.text) continue;
    const { normalized, indexMap } = normalizeWithIndexMap(source.text);
    const match = normalized.match(pattern);
    if (match && match.index !== undefined) {
      const span = sliceOriginalSource(source.text, indexMap, match.index, match.index + match[0].length);
      if (!span) continue;
      return { sourceKind: source.kind, sourceIndex: source.index, span, videoId: source.videoId ?? null };
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
  { pattern: /(?<![\\p{L}\\p{N}_])(se\u00f1ales|se\u00f1al|grupo|canal)(?![\\p{L}\\p{N}_]).{0,20}(?<![\\p{L}\\p{N}_])(\u00fanete|unete|gratis|gratuito|gratuita|vip)(?![\\p{L}\\p{N}_])/iu, code: 'signal-group-solicitation-es' },
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
  if (!args.vocabOk) failed.push('curated');
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
  return { admit: true, located, novelty, flags, spamSignals };
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

export async function readNativeQualityEvidence(
  termId: number,
  runner: Queryable
): Promise<NativeQualityRollup> {
  const result = await runner.query(NATIVE_QUALITY_ROLLUP_SQL, [termId]);
  const row = ((result.rows || [])[0] || {}) as Record<string, unknown>;
  return {
    v1Observations: Number(row.v1 || 0),
    spamConfirmed: row.spam === true,
    novel: row.novel === true,
  };
}

export async function observeTerminology(args: {
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
}, clientOverride?: Queryable): Promise<number | null> {
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
      const result = await observeTerminology(args, client);
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

  // 1. Insert or fetch canonical trading term WITHOUT advancing last_observed_at on conflict
  const saved = await runner.query(
    `INSERT INTO canonical_trading_terms(canonical_term, normalized_term, country, language, script, term_type, first_observed_at, last_observed_at)
     VALUES($1, $2, $3, $4, $5, $6, now(), now())
     ON CONFLICT(country, normalized_term) DO NOTHING
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

  // 2. Resolve native creator/locale evidence status
  let resolvedCreatorCountry: string | null = args.sourceCreatorCountry ? canonicalCountry(args.sourceCreatorCountry) : null;
  let resolvedMarketCountry: string | null = args.targetMarketCountry ? canonicalCountry(args.targetMarketCountry) : null;

  if (!resolvedCreatorCountry && args.channelId) {
    const channelRes = await runner.query(
      `SELECT country FROM channels WHERE channel_id = $1`,
      [args.channelId]
    ).catch(() => ({ rows: [] }));

    if (channelRes.rows && channelRes.rows[0] && channelRes.rows[0].country) {
      resolvedCreatorCountry = canonicalCountry(String(channelRes.rows[0].country));
    }
  }

  let resolvedNativeStatus: NativeEvidenceStatus | null = args.nativeEvidenceStatus || null;
  let resolvedProvenanceFamily: SourceProvenanceFamily | null = args.sourceProvenanceFamily || null;

  const sameCountryCreator = Boolean(resolvedCreatorCountry && resolvedCreatorCountry === country);
  const termLanguageMatchesContext = contextLang !== 'und' && codeSwitching.termLanguage === contextLang;
  if (!resolvedNativeStatus && sameCountryCreator && termLanguageMatchesContext) {
    resolvedNativeStatus = 'NATIVE_OBSERVED';
    resolvedProvenanceFamily = 'CREATOR_METADATA';
  }

  // 3. Compute deterministic observation key for single-write idempotency
  const obsKey = computeObservationKey({
    canonicalTermId: termId,
    channelId: args.channelId,
    videoId: args.videoId,
    observationType: args.observationType,
    nativeEvidenceStatus: resolvedNativeStatus,
    sourceProvenanceFamily: resolvedProvenanceFamily,
    sourceEvidenceId: args.sourceEvidenceId,
    evidence: args.evidence
  });

  // 4. Perform single, authoritative observation write
  const obsInsert = await runner.query(
    `INSERT INTO terminology_observations(
       canonical_term_id, source_channel_id, source_video_id, observation_type,
       human_approval_id, human_approved, community_fingerprint, evidence_weight, evidence,
       source_creator_country, target_market_country, locale, is_code_switched,
       native_language, term_language, native_evidence_status, source_provenance_family, code_switch_type,
       observation_key
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     ON CONFLICT(observation_key) DO NOTHING
     RETURNING id, observed_at`,
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
      obsKey
    ]
  );

  // 5. Invoke authoritative terminology lifecycle refresh & projection recompute ONLY if a new observation row was actually inserted!
  if (obsInsert.rows && obsInsert.rows.length > 0) {
    const obsAt = obsInsert.rows[0].observed_at || new Date().toISOString();
    await runner.query(
      `UPDATE canonical_trading_terms
       SET last_observed_at = GREATEST(last_observed_at, $2)
       WHERE id = $1`,
      [termId, obsAt]
    );
    await refreshTerminologyLifecycle(termId, DEFAULT_TERMINOLOGY_POLICY, runner);
    await recomputeNativeEvidenceProjection(termId, runner);
  }

  return termId;
}

export async function addTerminologyAlias(canonicalTermId: number, alias: string, aliasType: 'ABBREVIATION' | 'SPELLING' | 'TRANSLITERATION' | 'SHORTHAND' | 'REGIONAL' | 'SPELLING_VARIANT', language = 'und', clientOverride?: Queryable): Promise<void> {
  const normalized = normalizeTerm(alias);
  if (normalized.length < 2) return;
  const runner = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return;
  await runner.query(`INSERT INTO trading_term_aliases(canonical_term_id,alias,normalized_alias,language,script,alias_type) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(canonical_term_id,normalized_alias) DO NOTHING`, [canonicalTermId, alias.normalize('NFKC').trim(), normalized, language, inferScript(alias), aliasType]);
}

export async function refreshTerminologyLifecycle(termId: number, policy = DEFAULT_TERMINOLOGY_POLICY, clientOverride?: Queryable): Promise<void> {
  const runner = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return;
  const result = await runner.query(`SELECT t.*, COALESCE(o.distinct_creators,0)::int distinct_creators, COALESCE(o.distinct_communities,0)::int distinct_communities,
    COALESCE(o.human_approved,0)::int human_approved, COALESCE(o.decayed_evidence,0)::float decayed_evidence,
    COALESCE(p.executions,0)::int executions, COALESCE(p.decayed_yield,0)::float decayed_yield
    FROM canonical_trading_terms t LEFT JOIN LATERAL (SELECT COUNT(DISTINCT source_channel_id) FILTER (WHERE source_channel_id IS NOT NULL) distinct_creators,
      COUNT(DISTINCT community_fingerprint) FILTER (WHERE community_fingerprint IS NOT NULL) distinct_communities, COUNT(DISTINCT source_channel_id) FILTER (WHERE human_approved) human_approved,
      SUM(evidence_weight * power(0.5, EXTRACT(EPOCH FROM (now()-observed_at))/86400/$2)) decayed_evidence FROM terminology_observations WHERE canonical_term_id=t.id) o ON true
    LEFT JOIN LATERAL (SELECT COALESCE(SUM(executions),0) executions, COALESCE(SUM(decayed_yield_score*executions)/NULLIF(SUM(executions),0),0) decayed_yield FROM terminology_performance WHERE canonical_term_id=t.id) p ON true WHERE t.id=$1`, [termId, policy.halfLifeDays]);
  if (!result.rows[0]) return;
  const row = result.rows[0];
  const decision = decideLifecycle({ current: row.lifecycle_status, decayedEvidence: row.decayed_evidence, distinctCreators: row.distinct_creators, distinctCommunities: row.distinct_communities, executions: row.executions, decayedYield: row.decayed_yield, termType: row.term_type }, policy);
  // Native quality gate: applies ONLY when entering a search-eligible state
  // AND the term carries new-pipeline (qualityVersion) evidence. Legacy-only
  // terms take the legacy path below byte-identically; spam or non-novel
  // new terms are held at their current status with a recorded reason
  // instead of entering trial/proven states. Demotion stays yield-driven.
  // The quality rollup is read once; a second read would race concurrent
  // writers and is unnecessary.
  let qualityBlocked = false;
  const enteringEligibility = !row.search_eligible && decision.searchEligible;
  if (enteringEligibility) {
    const quality = await readNativeQualityEvidence(termId, runner);
    if (quality.v1Observations > 0) {
      const entry = evaluateTrialEntry({ novel: quality.novel, spamConfirmed: quality.spamConfirmed });
      if (!entry.allowed) {
        qualityBlocked = true;
        // event_type is CHECK-constrained to PROMOTION/DEMOTION/ELIGIBILITY_CHANGE:
        // same-status ELIGIBILITY_CHANGE with an explicit block reason.
        const blockReason = `quality-gate blocked trial entry: ${entry.reasons.join('; ')}`;
        // Idempotency: a term that stays blocked for the same reason must not
        // append a duplicate event on every refresh — record only when the
        // block reason changed since the latest event.
        const latest = await runner.query(
          `SELECT event_type, reason FROM terminology_lifecycle_events WHERE canonical_term_id=$1 ORDER BY id DESC LIMIT 1`,
          [termId]
        );
        const lastEvent = ((latest.rows || [])[0] || {}) as Record<string, unknown>;
        if (!(lastEvent.event_type === 'ELIGIBILITY_CHANGE' && lastEvent.reason === blockReason)) {
          await runner.query(
            `INSERT INTO terminology_lifecycle_events(canonical_term_id,from_status,to_status,event_type,reason,evidence_snapshot) VALUES($1,$2,$2,'ELIGIBILITY_CHANGE',$3,$4)`,
            [termId, row.lifecycle_status, blockReason, JSON.stringify({ v1Observations: quality.v1Observations, novel: quality.novel, spamConfirmed: quality.spamConfirmed })]
          );
        }
      }
    }
  }
  if (!qualityBlocked && (decision.status !== row.lifecycle_status || decision.searchEligible !== row.search_eligible)) {
    await runner.query('UPDATE canonical_trading_terms SET lifecycle_status=$2,search_eligible=$3,trust_tier=$4 WHERE id=$1', [termId, decision.status, decision.searchEligible, decision.status === 'PROVEN_SEARCH_TERM' ? 1 : decision.searchEligible ? 2 : 3]);
    await runner.query(`INSERT INTO terminology_lifecycle_events(canonical_term_id,from_status,to_status,event_type,reason,evidence_snapshot) VALUES($1,$2,$3,$4,$5,$6)`, [termId, row.lifecycle_status, decision.status, decision.status === 'DEMOTED' ? 'DEMOTION' : 'PROMOTION', decision.reason, JSON.stringify({ distinctCreators: row.distinct_creators, distinctCommunities: row.distinct_communities, executions: row.executions, decayedEvidence: row.decayed_evidence, decayedYield: row.decayed_yield })]);
  }
  // The snapshot records the persisted lifecycle state: when the quality
  // gate blocks a transition, decision.status was never applied.
  await runner.query(`INSERT INTO terminology_score_snapshots(canonical_term_id,distinct_creators,distinct_communities,human_approved_creators,decayed_evidence,decayed_yield_score,lifecycle_status,configuration) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [termId, row.distinct_creators, row.distinct_communities, row.human_approved, row.decayed_evidence, row.decayed_yield, qualityBlocked ? row.lifecycle_status : decision.status, JSON.stringify(policy)]);
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
  const terms = await runner.query('SELECT id FROM canonical_trading_terms WHERE country=$1 AND normalized_term=$2', [canonicalCountry(query.country), learned]);
  for (const row of terms.rows) {
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

export async function getPlannerTerminology(country: string, clientOverride?: Queryable): Promise<Array<{ id: number; term: string; score: number; lifecycle: 'SEARCH_TRIAL' | 'PROVEN_SEARCH_TERM' }>> {
  const runner = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return [];
  const result = await runner.query(`SELECT t.id,t.canonical_term term,t.lifecycle_status,COALESCE(AVG(p.decayed_yield_score),0)::float score FROM canonical_trading_terms t LEFT JOIN terminology_performance p ON p.canonical_term_id=t.id WHERE t.country=$1 AND t.search_eligible=true AND t.lifecycle_status IN ('SEARCH_TRIAL','PROVEN_SEARCH_TERM') GROUP BY t.id ORDER BY score DESC,t.last_observed_at DESC NULLS LAST LIMIT 50`, [canonicalCountry(country)]);
  return result.rows.map(row => ({ id: Number(row.id), term: row.term, score: Number(row.score), lifecycle: row.lifecycle_status as 'SEARCH_TRIAL' | 'PROVEN_SEARCH_TERM' }));
}
