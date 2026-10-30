import { GoogleGenAI } from '@google/genai';
import { ChannelRecord, CountryVocabulary, DiscoverySource, QualityScoreBreakdown, QueryRecord, QueryCollection, ExtractedTermRecord } from '../src/types';
import {
  getDb,
  getCountryVocabularies,
  getQueriesByCountry,
  upsertQueryRecord,
  updateQueryExecutionStats,
  setQueryCollection,
  saveExtractedTerm,
  getExtractedVocabulary,
  getChannelById,
  upsertChannel,
  getAppSetting,
  getQueryQualityRunRows,
  getQueryPortfolioBudgetState,
  getQueryQuotaSpendRows,
  getQueryFailureStates,
  getQueryRunReward,
  isRetryableInfrastructureFailure
} from './db';
import { assertCountryAllowed } from './countryExclusion';
import { isTerminologyKillSwitchActive, TERMINOLOGY_KILL_SWITCH_KEY } from './terminologyKillSwitch';
import { planCountryNativeProposalQuery, planDiverseQueries, planFrontierTargetedQuery, rotateAwayFromMostRecentIntent, reformulatePollutedQuery } from './queryPlanner';
import { revalidateQueryRecordAdmission, type QueryRecordAdmission } from './queryQuality/admission';
import { isRewardEligibleQuota } from './queryQuality/accounting';
import { selectionHistoryFor } from './queryQuality/composition';
import {
  DECAY_HALF_LIFE_DAYS,
  MAX_SELECTION_INDEX,
  MIN_SELECTION_SAMPLE,
  SELECTOR_C,
  computePosterior,
  decayArmCounts,
  decayWeight,
  empiricalPrior,
  promotionQualityScore,
} from './queryQuality/posterior';
import { coverageCellFor, portfolioBudget, buildHierarchy, selectHierarchicalUcb } from './queryQuality/selector';
import { isQuerySelectable } from './queryQuality/lifecycle';
import { getCountryMarketProfile } from './queryQuality/profiles';
import type { DecayedArmCounts, SelectorCandidate, SelectorContext, SelectorDecision } from './queryQuality/types';
import { selectQueryCollection, isSeverelyContaminatedQuery, PROVEN_LCB_THRESHOLD, PROVEN_MIN_COMPLETED_RUNS, type QueryFunnelMetrics, type QueryPromotionGuard } from './queryPerformance';
import { attributeTerminologyPerformance, buildNoveltyBaseline, classifyNativeCandidate, detectSpamSignals, findLiteralSpan, getPlannerTerminology, normalizeTerm, observeTerminology, observeTerminologyDetailed, KNOWN_INSTRUMENT_TERMS, type LiteralSourceText, type LiteralSpanMatch, type NativeAdmissionRejectReason, type NoveltyBaseline, type TerminologyObservationResult } from './terminologyIntelligence';
import type { ExplicitTerminologyLanguageContext } from './terminologyLanguageContext';
import { canonicalCountry } from './countryInference';
import { selectExplicitTerminologyLanguageContext } from './terminologyLanguageContext';
import { executeProviderCall, resolveGeminiRouteId } from './providerResilience';
import { geminiOrgIdForSlot } from './evidenceEngine/providers/GeminiSemanticProvider';
import { appendProviderCallEvent } from './db';
import { getPublishedOrganicQueryCandidates } from './organicQueryExpansion';
import { type DiscoveryNeighborhoodDimensions, createNeighborhoodKey } from './discoveryNeighborhood';

// AI Client lazy initialization
let aiClient: GoogleGenAI | null = null;
function getAIClient(): GoogleGenAI | null {
  if (!aiClient && process.env.GEMINI_API_KEY) {
    aiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
    });
  }
  return aiClient;
}

async function callGeminiSafe<T>(promptFn: () => Promise<T>, retries = 2, delayMs = 1500): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await promptFn();
    } catch (e: any) {
      const errStr = String(e?.message || e || '');
      const isTransient = e?.status === 503 || e?.code === 503 || errStr.includes('503') || errStr.includes('high demand') ||
                          e?.status === 429 || e?.code === 429 || errStr.includes('429') || errStr.includes('RESOURCE_EXHAUSTED') || errStr.includes('quota');
      if (isTransient && attempt < retries) {
        const backoff = delayMs * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      throw e;
    }
  }
  throw new Error('Gemini API call failed after retries');
}

// ==========================================
// 1. CREATOR QUALITY SCORER
// ==========================================

const TECHNICAL_TRADING_KEYWORDS = [
  'order flow', 'market structure', 'price action', 'volume profile',
  'delta divergence', 'fair value gap', 'fvg', 'liquidity sweep', 'ict concepts',
  'smc', 'smart money', 'premarket', 'technical analysis', 'backtest', 'session analysis',
  'dax analyse', 'cac 40', 'ftse', 'ibex 35', 'nq futures', 'es futures', 'xetra',
  'risk management', 'journal de trading', 'bitácora', 'morgenbriefing', 'analyse technique'
];

const SPAM_HYPE_KEYWORDS = [
  '1000x', '100% win rate', 'get rich', 'guaranteed profit', 'easy money',
  'millionaire overnight', 'secret hack', 'copy my trades 100%', 'free signal group'
];

/**
 * Calculates a non-engagement-dominant Creator Quality Score (0 - 100).
 * Freshness must come from observed publication timestamps/activity metadata;
 * merely receiving one or more search-result titles is not proof that a creator
 * is currently active.
 */
export function calculateCreatorQualityScore(
  channel: Partial<ChannelRecord> & { channel_name: string },
  videoTitles: string[] = [],
  description: string = ''
): { score: number; breakdown: QualityScoreBreakdown } {
  const reasons: string[] = [];
  const textCorpus = `${channel.channel_name} ${description} ${videoTitles.join(' ')}`.toLowerCase();

  // 1. Educational & Trading Authenticity (Max 35)
  let educationalScore = 15; // baseline neutral
  let techMatchCount = 0;
  for (const kw of TECHNICAL_TRADING_KEYWORDS) {
    if (textCorpus.includes(kw)) {
      techMatchCount++;
    }
  }
  if (techMatchCount >= 4) {
    educationalScore += 20;
    reasons.push(`High density of authentic trading concepts (${techMatchCount} technical terms found)`);
  } else if (techMatchCount >= 2) {
    educationalScore += 12;
    reasons.push(`Includes native technical trading terms (${techMatchCount} found)`);
  } else if (techMatchCount === 1) {
    educationalScore += 5;
    reasons.push('Basic trading terms present');
  } else {
    reasons.push('Limited explicit technical analysis keywords found');
  }

  // Deduct for spam hype
  let hypePenalty = 0;
  for (const hype of SPAM_HYPE_KEYWORDS) {
    if (textCorpus.includes(hype)) {
      hypePenalty += 10;
    }
  }
  if (hypePenalty > 0) {
    educationalScore = Math.max(0, educationalScore - hypePenalty);
    reasons.push(`Penalized for clickbait/get-rich marketing copy (-${hypePenalty} pts)`);
  }

  educationalScore = Math.min(35, Math.max(0, educationalScore));

  // 2. Freshness & Activity (Max 25). Unknown is deliberately neutral-low:
  // search result titles can be 5, 10, or 15 years old and must not earn a
  // maximum freshness score without an observed upload timestamp.
  let freshnessScore = 8;
  const band = channel.activity_band || 'UNKNOWN';
  if (band === 'VERY_ACTIVE') {
    freshnessScore = 25;
    reasons.push('Very active creator: latest observed upload is within 30 days');
  } else if (band === 'ACTIVE') {
    freshnessScore = 22;
    reasons.push('Active creator: latest observed upload is within 90 days');
  } else if (band === 'OCCASIONAL') {
    freshnessScore = 14;
    reasons.push('Occasionally active creator: latest observed upload is within one year');
  } else if (band === 'DORMANT') {
    freshnessScore = 2;
    reasons.push('Dormant creator: latest observed upload is older than one year');
  } else if (channel.latest_upload_at && Number.isFinite(Date.parse(channel.latest_upload_at))) {
    const ageDays = Math.max(0, (Date.now() - Date.parse(channel.latest_upload_at)) / 86_400_000);
    freshnessScore = ageDays <= 30 ? 25 : ageDays <= 90 ? 22 : ageDays <= 365 ? 14 : 2;
    reasons.push(`Freshness derived from latest observed upload (${Math.round(ageDays)} days ago)`);
  } else {
    reasons.push('Creator activity has not yet been verified; no freshness bonus awarded from search titles alone');
  }

  // 3. Community Presence (Max 25)
  let communityScore = 10;
  if (channel.discord_status === 'ACTIVE') {
    communityScore = 25;
    reasons.push('Verified active Discord/Telegram community with high member activity');
  } else if (channel.discord_status === 'ACTIVE_LOW_VOLUME') {
    communityScore = 20;
    reasons.push('Verified active community with moderate engagement');
  } else if (channel.discord_invite) {
    communityScore = 15;
    reasons.push('Community invite link detected and pending verification');
  } else {
    reasons.push('No verified trading community link found yet');
  }

  // 4. Low Fluff / Formatting Score (Max 15)
  let lowFluffScore = 12;
  if (channel.country_status === 'CONFIRMED') {
    lowFluffScore += 3;
    reasons.push('High country provenance match with native market alignment');
  }

  const totalScore = Math.min(100, Math.round(educationalScore + freshnessScore + communityScore + lowFluffScore));

  return {
    score: totalScore,
    breakdown: {
      educational_authenticity: Math.round(educationalScore),
      freshness_activity: Math.round(freshnessScore),
      community_presence: Math.round(communityScore),
      low_fluff_score: Math.round(lowFluffScore),
      reasons
    }
  };
}

// ==========================================
// 2. SELF-LEARNING VOCABULARY EXTRACTION LOOP
// ==========================================

/**
 * Extracts recurring trading terminology, instruments, and content styles
 * from high-quality creators and feeds them back into the knowledge base.
 */
export interface RuleInstrumentHit {
  instrument: string;
  located: LiteralSpanMatch;
  /** Solicitation signals in the matched source text (evidence-only). */
  sourceSpamSignals: string[];
}

/**
 * Boundary-aware rule matching over the single canonical instrument list.
 * Each known instrument is located with findLiteralSpan (word-boundary aware
 * for Latin scripts), so word fragments such as 'ES' inside 'heroes' never
 * become instrument evidence. Exported for unit testing.
 */
export function findRuleInstrumentHits(
  channelName: string,
  videoTitles: string[],
  description: string,
  videoIds?: Array<string | null>,
  origins?: ExtractionSourceOrigins
): RuleInstrumentHit[] {
  const sources = buildLiteralSources(channelName, videoTitles, description, videoIds, origins);
  const hits: RuleInstrumentHit[] = [];
  for (const instrument of KNOWN_INSTRUMENT_TERMS) {
    const located = findLiteralSpan(instrument, sources);
    if (!located) continue;
    const matchedSource = sources.find(
      source => source.kind === located.sourceKind && source.index === located.sourceIndex
    );
    hits.push({ instrument, located, sourceSpamSignals: matchedSource ? detectSpamSignals(matchedSource.text) : [] });
  }
  return hits;
}

/**
 * Align YouTube video IDs to video titles. Positional when the videos array
 * lines up exactly with the titles; title-matched fallback otherwise; null
 * where no video is known. Exported for unit testing.
 */
export function alignVideoIdsToTitles(
  titles: string[],
  videos?: Array<{ id?: string; title: string }>,
  matchedVideo?: { id?: string | null; title?: string | null }
): Array<string | null> {
  // Production fallback: when no hydrated video records exist but the matched
  // retrieval document carries the provider-native video ID, it forms a
  // single-video pool — never inferred or fabricated, only preserved through
  // title equality. Mismatched titles honestly yield null.
  const pool =
    videos && videos.length > 0
      ? videos
      : matchedVideo?.id && matchedVideo?.title
        ? [{ id: matchedVideo.id, title: matchedVideo.title }]
        : undefined;
  if (pool && pool.length === titles.length && pool.every((video, index) => video.title === titles[index])) {
    return pool.map(video => video.id ?? null);
  }
  // Title-match fallback consumes each video once: duplicate titles take the
  // next unmatched same-title video in encounter order, and positions with no
  // remaining match get null. Ambiguous duplicates therefore degrade to null
  // provenance instead of repeating one video's ID across positions.
  const used = new Set<number>();
  return titles.map(title => {
    const hit = (pool ?? []).findIndex((video, index) => !used.has(index) && video.title === title);
    if (hit < 0) return null;
    used.add(hit);
    return pool?.[hit]?.id ?? null;
  });
}

/**
 * Whether Gemini extraction has any text worth analyzing. The channel name
 * always counts: post-approval enrichment passes no metadata titles or
 * descriptions, but valid literal terminology in the channel name alone must
 * still reach native admission (with CHANNEL_NAME provenance). Exported for
 * unit testing.
 */
export function hasNativeExtractionText(channelName: string, titles: string[], description: string): boolean {
  return channelName.trim() !== '' || titles.length > 0 || description.length > 20;
}

/**
 * Parse Gemini vocabulary output. Returns undefined when no JSON object is
 * present; THROWS on malformed JSON (provider-side garbage — the caller
 * treats that as a provider failure with warn-and-skip, distinct from
 * persistence failures in admission, which propagate for retry).
 */
export function parseNativeVocabularyResponse(resText: string): { terminology?: unknown; instruments?: unknown; phrases?: unknown; formats?: unknown } | undefined {
  const jsonMatch = (resText || '').match(/\{[\s\S]*\}/);
  if (!jsonMatch) return undefined;
  return JSON.parse(jsonMatch[0]);
}

export interface ExtractionSourceOrigins {
  /** False when videoTitles are not YouTube metadata (fallbacks/prose). */
  videoTitlesAreMetadata?: boolean;
  /** False when description is not YouTube metadata (inspection prose). */
  descriptionIsMetadata?: boolean;
}

/**
 * Build literal-traceability sources with honest provenance kinds.
 * Non-metadata inputs (search-query fallback titles, inspection prose,
 * channel-name duplicates) are excluded from provenance evidence rather than
 * mislabeled as VIDEO_TITLE/DESCRIPTION. Exported for unit testing.
 */
export function buildLiteralSources(
  channelName: string,
  videoTitles: string[],
  description: string,
  videoIds?: Array<string | null>,
  origins?: ExtractionSourceOrigins
): LiteralSourceText[] {
  return [
    { kind: 'CHANNEL_NAME', index: 0, text: channelName },
    ...(origins?.videoTitlesAreMetadata === false
      ? []
      : videoTitles.map((value, index) => ({ kind: 'VIDEO_TITLE' as const, index, text: value, videoId: videoIds?.[index] ?? null }))),
    ...(origins?.descriptionIsMetadata === false
      ? []
      : [{ kind: 'DESCRIPTION' as const, index: 0, text: description }]),
  ];
}

export interface NativeAdmissionDeps {
  saveTerm: (country: string, term: string, category: 'terminology' | 'instrument' | 'phrase' | 'format', channelId?: string) => Promise<unknown>;
  observeTerm: (args: Parameters<typeof observeTerminologyDetailed>[0]) => Promise<TerminologyObservationResult | null>;
  log?: (message: string) => void;
  /**
   * Idempotent vocabulary repair (row + link + counters as one unit).
   * Defaults to defaultReconcileExtractedTerm.
   */
  reconcileTerm?: (country: string, term: string, category: 'terminology' | 'instrument' | 'phrase' | 'format', channelId?: string) => Promise<ReconcileOutcome>;
}

/**
 * Repair insert mirroring saveExtractedTerm's row shape, but ON CONFLICT DO
 * NOTHING instead of incrementing occurrences. Observation and
 * extracted-vocabulary persistence intentionally share no transaction (separate
 * lanes); when a save fails after its observation committed, a later replay
 * hits ON CONFLICT (observationInserted=false) and this repair recreates the
 * missing vocabulary row without double-counting — concurrent repairs are
 * naturally idempotent.
 */
export interface ReconcileOutcome {
  rowInserted: boolean;
  linkInserted: boolean;
}

/**
 * Idempotent vocabulary repair: reconciles the vocabulary row, its
 * channel source link, and the derived validation_count/trust_tier as one
 * unit. Row existence alone proves nothing (a save can fail after the row
 * upsert but before linkage/counters), so every repair re-resolves the row
 * id (normalized term equivalence — earliest spelling wins, no case-variant
 * duplicates), links the channel (ON CONFLICT DO NOTHING), and recomputes
 * the derived counters from the links. All inside one transaction under an
 * advisory lock on the normalized term identity, so concurrent repairs for
 * any spelling or channel collapse to one row with every valid link and
 * uninflated counts. Repaired rows start at occurrences 0: only genuine new
 * observations increment (via saveTerm), so a repair racing an in-flight
 * save can never inflate frequency — the saver always brings it to exactly 1.
 */
export async function defaultReconcileExtractedTerm(country: string, term: string, category: 'terminology' | 'instrument' | 'phrase' | 'format', sourceChannelId?: string, clientOverride?: { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }): Promise<ReconcileOutcome> {
  const { normalizeTerm: normalizeTermForReconcile } = await import('./terminologyIntelligence');
  const db = clientOverride ?? await getDb();
  const clean = term.trim();
  if (!clean) return { rowInserted: false, linkInserted: false };
  const normalized = normalizeTermForReconcile(clean);
  // Same write-boundary identity as saveExtractedTerm and the observation
  // layer: country aliases collapse to canonical so rows, locks, links, and
  // occurrence reconciliation never split by spelling.
  const countryCanon = canonicalCountry(country);
  const poolLike = 'connect' in (db as object) && typeof (db as { connect?: unknown }).connect === 'function' ? (db as unknown as import('pg').Pool) : null;
  const client = poolLike ? await poolLike.connect() : null;
  const runner = (client ?? db) as unknown as { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }> };
  try {
    if (client) await runner.query('BEGIN');
    await runner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`extracted-vocab:${countryCanon}:${normalized}`]);
    // Country-wide scan with in-code normalized comparison: SQL lower()
    // cannot express NFKC/whitespace canonicalization, so a lower() prefilter
    // would miss equivalent rows ('order  flow' vs 'order flow') and split
    // links across duplicate rows. Per-country vocabularies are small; repair
    // is rare, so the scan cost is bounded and correctness comes first.
    const existing = await runner.query(
      `SELECT id, term FROM extracted_trading_vocabulary WHERE country=$1 ORDER BY id ASC`,
      [countryCanon]
    );
    let rowId: number | null = null;
    let rowInserted = false;
    for (const row of existing.rows || []) {
      if (normalizeTermForReconcile(String(row.term)) === normalized) {
        rowId = Number(row.id);
        break;
      }
    }
    if (rowId === null) {
      const inserted = await runner.query(
        `INSERT INTO extracted_trading_vocabulary(country,term,category,source_channel_id,occurrences,first_extracted,last_extracted,trust_tier,validation_count) VALUES($1,$2,$3,$4,0,now(),now(),3,0) ON CONFLICT(country,term) DO NOTHING RETURNING id`,
        [countryCanon, clean, category, sourceChannelId || null]
      );
      if (inserted.rows?.[0]?.id !== undefined && inserted.rows?.[0]?.id !== null) {
        rowId = Number(inserted.rows[0].id);
        rowInserted = true;
      } else {
        const reread = await runner.query(
          `SELECT id, term FROM extracted_trading_vocabulary WHERE country=$1 ORDER BY id ASC`,
          [countryCanon]
        );
        for (const row of reread.rows || []) {
          if (normalizeTermForReconcile(String(row.term)) === normalized) {
            rowId = Number(row.id);
            break;
          }
        }
      }
    }
    let linkInserted = false;
    if (rowId !== null && sourceChannelId) {
      const linked = await runner.query(
        `INSERT INTO extracted_vocabulary_sources(term_id,channel_id) SELECT $1,$2 WHERE EXISTS(SELECT 1 FROM channels WHERE channel_id=$2 AND trading_status='TRADING_CONFIRMED') ON CONFLICT DO NOTHING RETURNING term_id`,
        [rowId, sourceChannelId]
      );
      linkInserted = (linked.rows?.length ?? 0) > 0;
      await runner.query(
        `UPDATE extracted_trading_vocabulary v SET validation_count=s.confirmed_sources,trust_tier=CASE WHEN s.confirmed_sources>=2 THEN 2 ELSE 3 END FROM (SELECT COUNT(DISTINCT evs.channel_id)::int confirmed_sources FROM extracted_vocabulary_sources evs JOIN channels c ON c.channel_id=evs.channel_id AND c.trading_status='TRADING_CONFIRMED' WHERE evs.term_id=$1) s WHERE v.id=$1`,
        [rowId]
      );
      // Frequency is derived from committed observations, never incremented
      // here: a repaired row converges to exactly the persisted evidence
      // count no matter how many repairs race or retry.
      await runner.query(
        `UPDATE extracted_trading_vocabulary v SET occurrences=s.n FROM (SELECT COUNT(*)::int n FROM terminology_observations o JOIN canonical_trading_terms t ON t.id=o.canonical_term_id WHERE t.country=$2 AND t.normalized_term=$3) s WHERE v.id=$1 AND EXISTS(SELECT 1 FROM canonical_trading_terms t WHERE t.country=$2 AND t.normalized_term=$3)`,
        [rowId, countryCanon, normalized]
      );
    }
    if (client) await runner.query('COMMIT');
    return { rowInserted, linkInserted };
  } catch (error) {
    if (client) await runner.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    if (client) client.release();
  }
}

export interface NativeAdmissionReport {
  admitted: number;
  /** Already-recorded observations reused idempotently (no new writes). */
  duplicates: number;
  rejected: Record<NativeAdmissionRejectReason, number>;
}

const EMPTY_ADMISSION_REJECTIONS = (): Record<NativeAdmissionRejectReason, number> => ({
  'non-string': 0,
  'too-short': 0,
  'non-literal': 0,
  spam: 0,
  'novelty-unknown': 0,
  'observation-failed': 0,
});

export interface ExtractionVideoSource {
  videoTitles: string[];
  videos?: Array<{ id?: string; title: string; language?: string }>;
  matchedDocument?: { type?: string; providerNativeId?: string; title?: string };
  description?: string;
  detectedLanguages?: Array<{ language: string; confidence?: number }>;
}

/**
 * Retry repair for preserved/confirmed channels: replays vocabulary extraction
 * so a save that failed after its observation committed cannot strand missing
 * rows behind early-return paths. Honors the normal extraction bars (confirmed
 * trading status, quality threshold, no manual-search training) exactly like
 * the main path. Idempotent; returns true when the replay completed without
 * error. While the terminology kill switch is active extraction is a no-op,
 * so `true` then means "no error", not "work performed" (production callers
 * currently ignore the value; tests assert it).
 */
export async function replayVocabularyForRetry(
  channel: ChannelRecord,
  candidate: ExtractionVideoSource,
  source: DiscoverySource,
  isRetry: boolean,
  deps?: { extractVocabulary?: typeof extractVocabularyFromCreator }
): Promise<boolean> {
  if (!isRetry) return false;
  if (source === 'manual_search') return false;
  if (channel.trading_status !== 'TRADING_CONFIRMED') return false;
  // Gate-1 halt-before-learning: rejected countries never train vocabulary,
  // including on the retry path.
  if (channel.country_status === 'REJECTED') return false;
  if (channel.quality_score == null || channel.quality_score < 55) return false;
  const extract = deps?.extractVocabulary ?? extractVocabularyFromCreator;
  await extract(
    channel,
    candidate.videoTitles,
    candidate.description ?? '',
    false,
    selectExplicitTerminologyLanguageContext(candidate),
    resolveExtractionVideoIds(candidate)
  );
  return true;
}

/**
 * Production ingestion handoff: align YouTube video IDs to titles. When no
 * hydrated video records exist, the matched retrieval document's
 * provider-native ID is preserved through title equality (never inferred).
 * Exported so the handoff composition itself is unit-testable.
 */
export function resolveExtractionVideoIds(candidate: ExtractionVideoSource): Array<string | null> {
  return alignVideoIdsToTitles(
    candidate.videoTitles,
    candidate.videos,
    candidate.matchedDocument?.type === 'VIDEO'
      ? { id: candidate.matchedDocument.providerNativeId, title: candidate.matchedDocument.title }
      : undefined
  );
}

export interface NoveltyBaselineDeps {
  getVocabularies?: () => Promise<CountryVocabulary[]>;
  getExtracted?: (country: string) => Promise<ExtractedTermRecord[]>;
}

/**
 * Loads the novelty baseline for one extraction. Lookup INFRASTRUCTURE
 * failures throw (caller retries via the job system); a successful lookup
 * with no country row resolves to an unknown baseline that rejects
 * candidates without throwing. Fail-closed classification and retryable
 * infrastructure errors are therefore distinct outcomes, never conflated.
 */
export async function loadNoveltyBaseline(
  country: string,
  deps?: NoveltyBaselineDeps
): Promise<NoveltyBaseline> {
  const getVocabularies = deps?.getVocabularies ?? getCountryVocabularies;
  const getExtracted = deps?.getExtracted ?? getExtractedVocabulary;
  let vocab: CountryVocabulary | undefined;
  let vocabOk = true;
  const failures: Array<{ lookup: string; error: unknown }> = [];
  try {
    const all = await getVocabularies();
    vocab = all.find(entry => entry.country.toLowerCase() === country.toLowerCase());
  } catch (error) {
    vocabOk = false;
    failures.push({ lookup: 'curated-vocabulary', error });
  }
  let existingTerms: string[] = [];
  let existingOk = true;
  try {
    existingTerms = (await getExtracted(country)).map(row => row.term);
  } catch (error) {
    existingOk = false;
    failures.push({ lookup: 'extracted-vocabulary', error });
  }
  if (!vocabOk || !existingOk) {
    // Preserve the original failure causes and retryable codes so
    // isRetryableInfrastructureFailure classifies this as infrastructure
    // (retry-policy path) rather than an ordinary failure that burns
    // max_attempts, and logs identify which lookup failed and why.
    // Retryability comes from ANY failure, judged by the same classifier the
    // job system uses: a later ETIMEDOUT must not hide behind an earlier
    // non-retryable error (or vice versa) — when any lookup failed
    // transiently, the job should use the retry policy rather than burning
    // max_attempts or silently dropping candidates.
    const retryableFirst = failures.find(failure => isRetryableInfrastructureFailure(failure.error));
    const primary = ((retryableFirst ?? failures[0])?.error ?? {}) as Record<string, unknown>;
    const thrown = new Error(
      `[Vocabulary Extraction] novelty baseline lookups failed for country ${country} ` +
      `(${failures.map(failure => `${failure.lookup}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`).join('; ')})`
    ) as Error & Record<string, unknown>;
    thrown.cause = (retryableFirst ?? failures[0])?.error;
    if (typeof primary.name === 'string' && primary.name) thrown.name = primary.name;
    for (const key of ['code', 'status', 'statusCode', 'retryable', 'errorClass', 'retryAt', 'retryAfterMs']) {
      if (thrown[key] === undefined && primary[key] !== undefined) thrown[key] = primary[key];
    }
    thrown.providerReasons = [
      ...new Set(
        failures.flatMap(failure =>
          Array.isArray((failure.error as Record<string, unknown> | null)?.providerReasons)
            ? ((failure.error as Record<string, unknown>).providerReasons as unknown[])
            : []
        ).map(String)
      ),
    ];
    throw thrown;
  }
  return buildNoveltyBaseline({ country, vocab, vocabOk, existingTerms, existingOk });
}

/**
 * Removes AI candidates already admitted by the rule path in the same
 * extraction run (normalized comparison). Rule and AI observations carry
 * different observation types, so without this filter one source mention
 * would persist twice and inflate evidence and occurrences.
 */
export function excludeRuleAdmittedInstruments(values: unknown[] | undefined, ruleObserved: Set<string>): unknown[] | undefined {
  if (!values) return undefined;
  return values.filter(raw => typeof raw !== 'string' || !ruleObserved.has(normalizeTerm(raw)));
}

/**
 * Ingestion-to-extraction handoff for vocabulary learning: resolves aligned
 * video IDs and invokes extraction with them. The extraction dependency is
 * injectable so tests can spy on exactly what the production path forwards.
 */
export async function invokeChannelVocabularyExtraction(
  channel: ChannelRecord,
  candidate: ExtractionVideoSource & { description?: string; detectedLanguages?: Array<{ language: string; confidence?: number }> },
  languageContext: ExplicitTerminologyLanguageContext | undefined,
  deps?: { extractVocabulary?: typeof extractVocabularyFromCreator }
): Promise<Array<string | null>> {
  const extractionVideoIds = resolveExtractionVideoIds(candidate);
  const extract = deps?.extractVocabulary ?? extractVocabularyFromCreator;
  await extract(
    channel,
    candidate.videoTitles,
    candidate.description ?? '',
    false,
    languageContext,
    extractionVideoIds
  );
  return extractionVideoIds;
}

/**
 * Admit parsed AI candidates into the native-v1 evidence ledger.
 * Classification is pure (classifyNativeCandidate); persistence is
 * observe-first — the extracted-term row is written only after a valid
 * terminology observation exists, so failed, invalid, or over-length
 * candidates never poison novelty retries. Dependencies are injectable for
 * unit testing; production defaults persist to the database.
 *
 * Emits one warn-level summary line when candidates were dropped or the
 * novelty baseline is unknown (counts by reason only, never source content),
 * so model drift and admission rate are observable.
 */
/**
 * Single success/failure boundary for AI-extracted vocabulary: at least one
 * candidate must survive the real admission checks the persistence path
 * applies — rule-exclusion, then literal/length/spam/novelty classification
 * via classifyNativeCandidate. This deliberately reuses the admission
 * classifier instead of a weaker duplicate validator, so the gate can never
 * accept what admission would reject (suppressing fallback for nothing) nor
 * reject what admission would accept. Novelty uses the provided baseline;
 * baseline-unavailable fails closed here exactly as in admission.
 */
export interface VocabularyAdmissibilityContext {
  sources: LiteralSourceText[];
  baseline: NoveltyBaseline;
  language?: string;
  ruleObserved: Set<string>;
}

export function isAdmissibleParsed(
  parsed: { terminology?: unknown; instruments?: unknown; phrases?: unknown; formats?: unknown } | undefined,
  ctx: VocabularyAdmissibilityContext
): boolean {
  if (!parsed) return false;
  const buckets = [parsed.terminology, parsed.instruments, parsed.phrases, parsed.formats];
  return buckets.some(
    bucket =>
      Array.isArray(bucket) &&
      bucket.some(raw => {
        if (typeof raw !== 'string') return false;
        if (ctx.ruleObserved.has(normalizeTerm(raw))) return false;
        // Mirrors observeTerminologyDetailed's upper length bound, which the
        // classifier does not enforce: overlong candidates are rejected
        // downstream without throwing, so accepting them here would suppress
        // fallback for nothing.
        if (normalizeTerm(raw).length > 80) return false;
        const verdict = classifyNativeCandidate(raw, ctx.sources, ctx.baseline, { language: ctx.language });
        return verdict.admit === true;
      })
  );
}

export async function admitNativeCandidates(args: {
  channel: ChannelRecord;
  sources: LiteralSourceText[];
  parsed: { terminology?: unknown[]; instruments?: unknown[]; phrases?: unknown[]; formats?: unknown[] };
  baseline: NoveltyBaseline;
  language?: string;
  locale?: string;
  humanApproved: boolean;
  humanObservation: 'HUMAN_APPROVED_CHANNEL' | 'ENRICHMENT';
  /** Extraction provider recorded on observation evidence (default GEMINI preserves existing callers). */
  extractor?: string;
  deps?: NativeAdmissionDeps;
}): Promise<NativeAdmissionReport> {
  const saveTerm = args.deps?.saveTerm ?? ((country, term, category, channelId) => saveExtractedTerm(country, term, category, channelId));
  const observeTerm = args.deps?.observeTerm ?? ((observeArgs) => observeTerminologyDetailed(observeArgs));
  const reconcileTerm = args.deps?.reconcileTerm ?? defaultReconcileExtractedTerm;
  const log = args.deps?.log ?? ((message) => console.warn(message));
  const rejected = EMPTY_ADMISSION_REJECTIONS();
  let admitted = 0;
  let duplicates = 0;
  const admit = async (
    raw: unknown,
    category: 'terminology' | 'instrument' | 'phrase' | 'format',
    termType: 'TERMINOLOGY' | 'INSTRUMENT' | 'PHRASE' | 'FORMAT',
    observationType: 'HUMAN_APPROVED_CHANNEL' | 'ENRICHMENT',
    approved: boolean | undefined
  ): Promise<void> => {
    const verdict = classifyNativeCandidate(raw, args.sources, args.baseline, { language: args.language });
    if (verdict.admit === false) {
      rejected[verdict.reason] += 1;
      return;
    }
    const observation = await observeTerm({
      term: String(raw), country: args.channel.country, termType, observationType,
      channelId: args.channel.channel_id, videoId: verdict.located.videoId ?? undefined, humanApproved: approved,
      language: args.language, locale: args.locale,
      communityFingerprint: args.channel.discord_invite || undefined,
      evidence: {
        extractor: args.extractor ?? 'GEMINI', qualityVersion: 'native-v1', literal: true,
        sourceRef: { kind: verdict.located.sourceKind, index: verdict.located.sourceIndex, span: verdict.located.span, videoId: verdict.located.videoId ?? null, sourceHash: verdict.located.sourceHash },
        novel: verdict.novelty.novel, knownAs: verdict.novelty.knownAs,
        generic: verdict.flags.generic, spamConfirmed: false, spamSignals: verdict.spamSignals, sourceSpamSignals: verdict.sourceSpamSignals,
        translationRisk: verdict.flags.translationRisk,
      },
    });
    if (observation == null) {
      rejected['observation-failed'] += 1;
      return;
    }
    // Occurrence counts advance only on newly persisted evidence. A replayed
    // (already-recorded) observation is reconciled as a unit — row, channel
    // link, and derived counters — because row existence alone never proves a
    // past save completed. Thrown errors propagate (never swallowed).
    if (!observation.observationInserted) {
      const repair = await reconcileTerm(args.channel.country, String(raw), category, args.channel.channel_id);
      if (repair.rowInserted || repair.linkInserted) admitted += 1;
      else duplicates += 1;
      return;
    }
    await saveTerm(args.channel.country, String(raw), category, args.channel.channel_id);
    admitted += 1;
  };
  if (args.parsed.terminology) {
    for (const t of args.parsed.terminology) await admit(t, 'terminology', 'TERMINOLOGY', args.humanObservation, args.humanApproved);
  }
  if (args.parsed.instruments) {
    for (const i of args.parsed.instruments) await admit(i, 'instrument', 'INSTRUMENT', args.humanObservation, args.humanApproved);
  }
  if (args.parsed.phrases) {
    for (const pp of args.parsed.phrases) await admit(pp, 'phrase', 'PHRASE', 'ENRICHMENT', undefined);
  }
  if (args.parsed.formats) {
    for (const f of args.parsed.formats) await admit(f, 'format', 'FORMAT', 'ENRICHMENT', undefined);
  }
  const dropped = (Object.values(rejected) as number[]).reduce((sum, count) => sum + count, 0);
  if (dropped > 0 || !args.baseline.ok) {
    log(
      `[Vocabulary Extraction] channel ${args.channel.channel_id} native admission: admitted=${admitted} duplicates=${duplicates} ` +
      `rejected=${JSON.stringify(rejected)} noveltyBaseline=${args.baseline.ok ? 'ok' : `unknown:${args.baseline.failed.join(',')}`}`
    );
  }
  return { admitted, duplicates, rejected };
}

export async function extractVocabularyFromCreator(
  channel: ChannelRecord,
  videoTitles: string[] = [],
  description: string = '',
  humanApproved = false,
  languageContext?: ExplicitTerminologyLanguageContext,
  videoIds?: Array<string | null>,
  origins?: ExtractionSourceOrigins,
  deps?: { isKillSwitchActive?: () => Promise<boolean> }
): Promise<ExtractedTermRecord[]> {
  const extracted: ExtractedTermRecord[] = [];

  // Extraction-path kill switch: while active this function is a hard no-op.
  // No rule evidence, no provider calls (Groq or Gemini), no writes — the
  // emergency stop must stop new terminology evidence, not just the AI leg.
  // The check runs before any database work so a stop cannot depend on the
  // rest of the pipeline being healthy.
  const killSwitchActive = await (deps?.isKillSwitchActive ?? isTerminologyKillSwitchActive)();
  if (killSwitchActive) {
    console.warn(
      `[Vocabulary Extraction] Skipped for channel ${channel.channel_id}: terminology kill switch is active (app_settings.${TERMINOLOGY_KILL_SWITCH_KEY}='true').`
    );
    return [];
  }

  const ai = getAIClient();

  if (!channel.country || channel.country === 'Unknown' || channel.trading_status !== 'TRADING_CONFIRMED') return [];

  // 1. Rule-based extraction of instruments over the single canonical list
  // (KNOWN_INSTRUMENT_TERMS — shared with novelty classification, never
  // duplicated). Boundary-aware literal matching: 'ES' inside 'heroes' or
  // 'trades' is a word fragment, never instrument evidence.
  // Within-run dedupe: instruments validly observed here suppress their AI
  // twins below (different observation types would otherwise record the same
  // source mention twice and inflate evidence and occurrences).
  const ruleObserved = new Set<string>();
  for (const hit of findRuleInstrumentHits(channel.channel_name, videoTitles, description, videoIds, origins)) {
    // Persistence ordering mirrors the AI path: terminology evidence first,
    // extracted-term row only after a valid observation exists.
    const ruleObservation = await observeTerminologyDetailed({ term: hit.instrument, country: channel.country, termType: 'INSTRUMENT', observationType: humanApproved ? 'HUMAN_APPROVED_CHANNEL' : hit.located.sourceKind, channelId: channel.channel_id, videoId: hit.located.videoId ?? undefined, humanApproved, language: languageContext?.language, locale: languageContext?.locale, communityFingerprint: channel.discord_invite || undefined, evidence: { extractor: 'KNOWN_INSTRUMENT_V1', sourceType: hit.located.sourceKind, qualityVersion: 'native-v1', literal: true, sourceRef: { kind: hit.located.sourceKind, index: hit.located.sourceIndex, span: hit.located.span, videoId: hit.located.videoId ?? null, sourceHash: hit.located.sourceHash }, novel: false, knownAs: `instrument:${hit.instrument}`, generic: true, spamConfirmed: false, spamSignals: [] as string[], sourceSpamSignals: hit.sourceSpamSignals, translationRisk: null } });
    if (ruleObservation == null) continue;
    ruleObserved.add(normalizeTerm(hit.instrument));
    if (ruleObservation.observationInserted) {
      await saveExtractedTerm(channel.country, hit.instrument, 'instrument', channel.channel_id);
    } else {
      await defaultReconcileExtractedTerm(channel.country, hit.instrument, 'instrument', channel.channel_id);
    }
  }

  // 2. Deep Gemini Extraction if API Key is configured
  // Non-metadata inputs (origins) are invisible to vocabulary provenance:
  // titles/descriptions that are not YouTube metadata never become literal
  // sources, rule spans, or quoted prompt context.
  const effTitles = origins?.videoTitlesAreMetadata === false ? [] : videoTitles;
  const effDesc = origins?.descriptionIsMetadata === false ? '' : description;
  // Groq runs on its own key configuration: only the Gemini fallback is
  // gated on the Gemini client.
  if (hasNativeExtractionText(channel.channel_name, effTitles, effDesc)) {
    // Provider failures (quota/busy/malformed model output) warn and skip AI
    // extraction. Persistence failures from admission below are NOT caught
    // here: they propagate to the caller for retry instead of being
    // misreported as Gemini errors or silently swallowed.
    let parsed: { terminology?: unknown; instruments?: unknown; phrases?: unknown; formats?: unknown } | undefined;
    let parsedSource: 'GROQ' | 'GEMINI' = 'GEMINI';
    const prompt = `Analyze this YouTube trading channel and recent video titles for country "${channel.country}".
Channel Name: "${channel.channel_name}"
Description: "${effDesc}"
Recent Titles:
${effTitles.map(t => `- ${t}`).join('\n')}

Identify localized trading vocabulary used by traders in ${channel.country}. Each bucket has a strict trading meaning:
- "terminology": native market, method, execution or platform language used by traders (for example "analyse technique", "order flow", "scalping").
- "instruments": tradeable instruments, exchanges or contracts (for example "NQ Futures", "XAUUSD", "DAX").
- "phrases": multiword phrases with a genuine market/trading meaning (for example "live trading", "trade review", "risk management").
- "formats": trading-specific content formats only (for example "live trading", "trade review"), never generic packaging.
Quote every term EXACTLY as it appears in the texts above: do not paraphrase, translate, or invent terms.
Exclude calls to action (subscribe, like, comment, notification), channel boilerplate, episode/part/volume labels, emoji-only or symbol-only surfaces, hashtags, URLs, handles, and generic words such as "free", "video", "channel", "interview", "live" or "session" without a trading qualifier. Do not return "Subscribe and Like button", "Free Interviews", "Épisode 6", "🔴" or "#trading".
Return ONLY a valid JSON object with format:
{
  "terminology": ["term1", "term2"],
  "instruments": ["inst1"],
  "phrases": ["phrase1"],
  "formats": ["format1"]
}`;

    // Literal sources are built before any provider attempt, and the novelty
    // baseline loads here too, so the success/failure boundary below can
    // apply the real admission checks. Pure/sync sources; baseline infra
    // failures throw here (fail fast, no provider spend) and the job retries.
    const literalSources = buildLiteralSources(channel.channel_name, effTitles, effDesc, videoIds, origins);
    const baseline = await loadNoveltyBaseline(channel.country);
    const isAdmissible = (
      p: { terminology?: unknown; instruments?: unknown; phrases?: unknown; formats?: unknown } | undefined
    ): boolean =>
      isAdmissibleParsed(p, {
        sources: literalSources,
        baseline,
        language: languageContext?.language,
        ruleObserved,
      });
    // Groq primary: same prompt, same parser, same admission below. Any
    // Groq failure (no keys, deferral, 429, error) falls through to the
    // unchanged Gemini path; total failure keeps warn-and-skip.
    try {
      const { runGroqTextCompletion } = await import('./evidenceEngine/providers/GroqSemanticProvider');
      const groqText = await runGroqTextCompletion(
        { prompt },
        {
          validateContent: text => {
            let candidate: ReturnType<typeof parseNativeVocabularyResponse>;
            try {
              candidate = parseNativeVocabularyResponse(text);
            } catch {
              return false;
            }
            return isAdmissible(candidate);
          },
        }
      );
      // Admissibility gate: provider output with no admissible candidate is
      // not a result — the Gemini fallback stays available instead of being
      // suppressed. Rule exclusion runs INSIDE the gate (not after it), so
      // instruments the rule pass already admitted cannot suppress fallback
      // on their own.
      const groqParsed = groqText ? parseNativeVocabularyResponse(groqText) : undefined;
      if (isAdmissible(groqParsed)) {
        parsed = groqParsed;
        parsedSource = 'GROQ';
      }
    } catch (e: any) {
      console.warn(`[Vocabulary Extraction] Groq attempt skipped for channel ${channel.channel_id}; trying Gemini fallback.`);
    }
    if (!parsed && ai) {
      try {
        const response = await callGeminiSafe(() => executeProviderCall({context:{provider:'gemini',operation:'vocabulary-extraction',requestMetadata:{geminiRoute:resolveGeminiRouteId('gemini-1'),geminiOrg:geminiOrgIdForSlot(process.env,1)}},timeoutMs:Number(process.env.GEMINI_PROVIDER_TIMEOUT_MS||'45000'),enabled:process.env.PROVIDER_DEADLINES_ENABLED==='true',emit:appendProviderCallEvent,call:() => ai.models.generateContent({
          model: 'gemini-3.6-flash',
          contents: prompt
        })}));

        const resText = response.text || '';
        parsed = parseNativeVocabularyResponse(resText);
      } catch (e: any) {
        const msg = e?.message || String(e);
        const isQuota = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota');
        const is503 = msg.includes('503') || msg.includes('high demand');
        if (isQuota) {
          console.warn(`[Vocabulary Extraction] Gemini API quota limit reached (429) for channel ${channel.channel_id}. Falling back to heuristic vocabulary extraction.`);
        } else if (is503) {
          console.warn(`[Vocabulary Extraction] Gemini API temporarily busy (503) for channel ${channel.channel_id}. Heuristic extraction retained.`);
        } else {
          console.warn(`[Vocabulary Extraction] Notice for channel ${channel.channel_id}:`, msg.length > 150 ? msg.slice(0, 150) + '...' : msg);
        }
      }
    }
    if (parsed) {
        // Literal, traceable admission (native-v1 pipeline) via the shared
        // admitNativeCandidates helper: classification (literal → spam →
        // fail-closed novelty), observe-first persistence, rejection stats.
        // Sources and baseline were built above for the admissibility gate
        // and are reused. Fail closed: a missing country row marks the
        // baseline unknown and every candidate is rejected as novelty-unknown
        // — a transient read error must never make a known term look novel.
        // Lookup infrastructure failures throw (via loadNoveltyBaseline) so
        // the job retries instead of silently discarding candidates.
        const humanObservation = humanApproved ? 'HUMAN_APPROVED_CHANNEL' as const : 'ENRICHMENT' as const;
        // Within-run dedupe against rule-admitted instruments (see above).
        const deduped = (values: unknown[] | undefined) => excludeRuleAdmittedInstruments(values, ruleObserved);
        await admitNativeCandidates({
          channel,
          sources: literalSources,
          parsed: {
            terminology: deduped(Array.isArray(parsed.terminology) ? parsed.terminology : undefined),
            instruments: deduped(Array.isArray(parsed.instruments) ? parsed.instruments : undefined),
            phrases: deduped(Array.isArray(parsed.phrases) ? parsed.phrases : undefined),
            formats: deduped(Array.isArray(parsed.formats) ? parsed.formats : undefined),
          },
          baseline,
          language: languageContext?.language,
          locale: languageContext?.locale,
          humanApproved,
          humanObservation,
          extractor: parsedSource,
        });
    }
  }

  // Enrich country vocabulary in memory/database with top extracted terms
  const newlyExtracted = await getExtractedVocabulary(channel.country);
  return newlyExtracted;
}

// ==========================================
// 3. HIERARCHICAL, COST-AWARE UCB QUERY SELECTOR
// ==========================================

export interface QuerySelectionResult {
  queryRecord: QueryRecord;
  selectionStrategy:
    | 'UCB_EXPLOITATION'
    | 'UCB_PORTFOLIO'
    | 'COLD_START_GENERATION'
    | 'NEIGHBORHOOD_TARGETED';
  reason: string;
  selector?: SelectorDecision;
  admission?: {
    hash: string;
    tier: string;
    compositionFamily: string;
    reasonCodes: string[];
  };
}

function primaryKey(value: string | undefined | null): string {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en');
}

const emptyArmCounts = (): DecayedArmCounts => ({ confirmed: 0, quality: 0, quotaUnits: 0, runs: 0 });

/**
 * Selects the next query with the Q4 hierarchical, cost-aware UCB policy.
 *
 * Hard gates (lifecycle, cooldown, same-tick, admission) run before scoring.
 * The old UCB1 formula, the `Math.random()` exploration branch, the
 * least-executed-first ordering and the unscored generated fallback are
 * retired. A generated candidate is re-admitted and scored before execution;
 * if the pool is still empty the selector returns null with an explicit
 * NO_ELIGIBLE_QUERY decision.
 */
export async function selectNextQueryForCountry(
  country: string,
  options: {
    targetNeighborhoodDimensions?: DiscoveryNeighborhoodDimensions;
    /**
     * Persistent-scope promotion basis (see planDiverseQueries). Set when the
     * country was explicitly selected by the operator, so an anchor-less
     * supported country can bootstrap instead of staying dormant forever.
     */
    scopePromotionBasis?: 'PERSISTENT_SCOPE_SELECTION' | 'DIRECT_TARGET';
  } = {}
): Promise<{
  queryRecord: QueryRecord;
  selectionStrategy: QuerySelectionResult['selectionStrategy'];
  selector?: SelectorDecision;
  admission?: QuerySelectionResult['admission'];
  reason: string;
} | null> {
  const now = new Date();
  const nowIso = now.toISOString();
  const cooldownMinutes = Math.max(1, Number(await getAppSetting('query_intelligence_query_cooldown_minutes', process.env.QUERY_INTELLIGENCE_COOLDOWN_MINUTES || '360')) || 360);
  const maxPrimaryUses = Math.max(1, Number(await getAppSetting('query_intelligence_primary_term_max_uses', process.env.QUERY_INTELLIGENCE_PRIMARY_TERM_MAX_USES || '2')) || 2);
  // The retired UCB1 formula's explorationRatio is replaced by the bounded
  // portfolio ratio. Keeping the name visible documents the policy migration
  // for audit consumers while no random exploration remains in serving.
  const configuredPortfolioRatio = Math.min(0.20, Math.max(0.10, Number(await getAppSetting('query_intelligence_portfolio_ratio', process.env.QUERY_INTELLIGENCE_PORTFOLIO_RATIO || '0.15')) || 0.15));
  const portfolioRatio = portfolioBudget(1, configuredPortfolioRatio).ratio;
  const familyCap = Math.min(1, Math.max(0.1, Number(await getAppSetting('query_intelligence_family_share_cap', process.env.QUERY_INTELLIGENCE_FAMILY_SHARE_CAP || '0.45')) || 0.45));
  const sourceCap = Math.min(1, Math.max(0.1, Number(await getAppSetting('query_intelligence_source_share_cap', process.env.QUERY_INTELLIGENCE_SOURCE_SHARE_CAP || '0.60')) || 0.60));

  const loadQueries = async (): Promise<QueryRecord[]> => getQueriesByCountry(country);
  const loadPool = async (queries: QueryRecord[]): Promise<SelectorPool> =>
    buildSelectorPool(country, queries, { now, cooldownMinutes, maxPrimaryUses, nowIso, portfolioRatio, familyCap, sourceCap });

  let allQueries = await loadQueries();
  if (allQueries.length === 0) {
    const generated = await generateCandidateQueriesForCountry(country, 4, 'COLD_START', { scopePromotionBasis: options.scopePromotionBasis });
    const selected = generated[0];
    if (!selected) return null;
    // Generated rows are reloaded and re-admitted through the same pool; the
    // first generated candidate only proves that generation produced output.
    const pool = await loadPool(await loadQueries());
    if (!pool.decision.queryId) return null;
    const admitted = pool.queriesById.get(pool.decision.queryId);
    if (!admitted) return null;
    return buildSelectionResult(admitted, pool, 'COLD_START_GENERATION', `Cold start query initialization for ${country}: ${pool.decision.reason}`, pool.decision);
  }

  let pool = await loadPool(allQueries);
  // An empty pool means every row is cooling down, saturated by a share cap,
  // or stale after admission revalidation. Never execute an unscored legacy
  // fallback: generate through the governed planner, then re-admit and score.
  if (pool.candidates.length === 0 || pool.decision.strategy === 'NO_ELIGIBLE_QUERY') {
    const generated = await generateCandidateQueriesForCountry(country, 4, 'EXPLORATION', { scopePromotionBasis: options.scopePromotionBasis });
    if (generated.length > 0) {
      allQueries = await loadQueries();
      pool = await loadPool(allQueries);
    }
  }

  if (options.targetNeighborhoodDimensions) {
    const target = options.targetNeighborhoodDimensions;
    const targetKey = createNeighborhoodKey(target);
    const matches = pool.candidates.filter(candidate => {
      const query = pool.queriesById.get(candidate.queryId);
      if (!query) return false;
      const dimensions: DiscoveryNeighborhoodDimensions = {
        country: target.country || country,
        language: target.language,
        queryIntent: query.intent || target.queryIntent,
        primaryTermFamily: query.primary_term || query.query,
        retrievalLane: target.retrievalLane,
        searchOrdering: target.searchOrdering,
        instrumentOrTheme: target.instrumentOrTheme,
        sourceFamily: target.sourceFamily,
      };
      return createNeighborhoodKey(dimensions) === targetKey;
    });
    if (matches.length > 0) {
      const targeted = selectHierarchicalUcb(matches, pool.context);
      const selected = targeted.queryId ? pool.queriesById.get(targeted.queryId) : null;
      if (selected) {
        return buildSelectionResult(selected, pool, 'NEIGHBORHOOD_TARGETED', `Frontier neighborhood canonical selection for target key "${targetKey}": ${targeted.reason}`, targeted);
      }
    } else {
      const generated = await generateCandidateQueriesForCountry(country, 1, 'EXPLORATION', { scopePromotionBasis: options.scopePromotionBasis });
      const matchingGenerated = generated.find(query => {
        const dimensions: DiscoveryNeighborhoodDimensions = {
          country: target.country || country,
          language: target.language,
          queryIntent: query.intent || target.queryIntent,
          primaryTermFamily: query.primary_term || query.query,
          retrievalLane: target.retrievalLane,
          searchOrdering: target.searchOrdering,
          instrumentOrTheme: target.instrumentOrTheme,
          sourceFamily: target.sourceFamily,
        };
        return createNeighborhoodKey(dimensions) === targetKey;
      });
      if (matchingGenerated) {
        const refreshed = await loadPool(await loadQueries());
        const candidate = refreshed.candidates.find(item => item.queryId === matchingGenerated.id);
        if (candidate) {
          const decision = selectHierarchicalUcb([candidate], refreshed.context);
          if (decision.queryId) {
            return buildSelectionResult(matchingGenerated, refreshed, 'NEIGHBORHOOD_TARGETED', `Generated candidate matching targeted frontier neighborhood key "${targetKey}": ${matchingGenerated.query}.`, decision);
          }
        }
      }
      const plannedTarget = planFrontierTargetedQuery({ country, target });
      if (plannedTarget) {
        const selected = await upsertQueryRecord({
          query: plannedTarget.query,
          country,
          collection: 'EXPERIMENTAL',
          intent: plannedTarget.intent,
          knowledgeTiers: plannedTarget.knowledgeTiers,
          generationMode: plannedTarget.generationMode,
          generationReason: plannedTarget.generationReason,
          discoveryObjective: plannedTarget.discoveryObjective,
          primaryTerm: plannedTarget.primaryTerm,
          generationMetadata: plannedTarget.metadata,
        });
        const refreshed = await loadPool(await loadQueries());
        const candidate = refreshed.candidates.find(item => item.queryId === selected.id);
        if (candidate) {
          const decision = selectHierarchicalUcb([candidate], refreshed.context);
          if (decision.queryId) {
            return buildSelectionResult(selected, refreshed, 'NEIGHBORHOOD_TARGETED', `Constructed governed fallback for targeted frontier neighborhood key "${targetKey}".`, decision);
          }
        }
      }
    }
  }

  if (pool.candidates.length === 0) return null;
  const decision = selectHierarchicalUcb(pool.candidates, pool.context);
  if (!decision.queryId) return null;
  const selected = pool.queriesById.get(decision.queryId);
  if (!selected) return null;
  return buildSelectionResult(
    selected,
    pool,
    decision.strategy === 'UCB_PORTFOLIO' ? 'UCB_PORTFOLIO' : 'UCB_EXPLOITATION',
    decision.reason,
    decision,
  );
}

interface SelectorPool {
  candidates: SelectorCandidate[];
  queriesById: Map<number, QueryRecord>;
  admissions: Map<number, QueryRecordAdmission>;
  context: SelectorContext;
  decision: SelectorDecision;
}

function buildSelectorCandidate(
  record: QueryRecord,
  admissionInfo: QueryRecordAdmission | undefined,
  admission: QueryRecordAdmission['admission'] | undefined,
  counts: DecayedArmCounts,
): SelectorCandidate {
  const profile = getCountryMarketProfile(record.country);
  return {
    queryId: record.id,
    query: record.query,
    collection: record.collection,
    country: admission?.country || record.country,
    language: admission?.language || profile.languages[0] || 'en',
    market: admission?.market || profile.primaryMarket,
    compositionFamily: admission?.compositionFamily || 'family:UNKNOWN',
    tier: admission?.tier || 'SPECULATIVE',
    primaryTerm: record.primary_term || record.query,
    counts,
    admission,
    nextEligibleAt: (record as QueryRecord & { next_eligible_at?: string | null }).next_eligible_at,
    reservedUntil: (record as QueryRecord & { reserved_until?: string | null }).reserved_until,
  };
}

async function buildSelectorPool(
  country: string,
  queries: QueryRecord[],
  options: {
    now: Date;
    cooldownMinutes: number;
    maxPrimaryUses: number;
    nowIso: string;
    portfolioRatio: number;
    familyCap: number;
    sourceCap: number;
  },
): Promise<SelectorPool> {
  const recentCutoff = options.now.getTime() - options.cooldownMinutes * 60_000;
  const primaryUsage = new Map<string, number>();
  for (const query of queries) {
    if (!query.primary_term || !query.last_executed) continue;
    if (Date.parse(query.last_executed) <= recentCutoff) continue;
    const key = primaryKey(query.primary_term);
    primaryUsage.set(key, (primaryUsage.get(key) || 0) + 1);
  }

  const [qualityRows, spendRows, failureStates] = await Promise.all([
    getQueryQualityRunRows(country),
    getQueryQuotaSpendRows(country),
    getQueryFailureStates(country),
  ]);
  const rowsByQuery = new Map<number, Array<{ confirmed: number; quality: number; quotaUnits: number; ageDays: number }>>();
  for (const row of qualityRows) {
    if (!(row.quotaUnits > 0)) continue;
    const list = rowsByQuery.get(row.queryId) || [];
    list.push(row);
    rowsByQuery.set(row.queryId, list);
  }
  const countsById = new Map<number, DecayedArmCounts>();
  for (const query of queries) {
    countsById.set(query.id, decayArmCounts(rowsByQuery.get(query.id) || [], DECAY_HALF_LIFE_DAYS));
  }
  const prior = empiricalPrior([...countsById.values()], 0.05, 2);

  // Share accounting covers every query in the country's accounting window,
  // not only the survivors of cooldown/intent rotation. Otherwise a cooling
  // query's spend disappears and a sibling from the same family/source can
  // exceed the cap. Pending/reserved runs are included at their reserved
  // weight so committed quota cannot be bypassed before completion.
  const spendById = new Map<number, number>();
  for (const row of spendRows) {
    spendById.set(row.queryId, (spendById.get(row.queryId) || 0) + row.quotaUnits * decayWeight(row.ageDays, DECAY_HALF_LIFE_DAYS));
  }
  const failureByQuery = new Map(failureStates.map(state => [state.queryId, state]));
  // A persisted row can be a losing duplicate of an older row. Keep the
  // deterministic oldest row as the group's winner and omit higher-id
  // duplicates from its history; otherwise mutually duplicate rows suppress
  // each other and neither can ever be selected. Losing rows still see the
  // winner and remain rejected.
  const historyEntries = queries.map(query => {
    const aliasOf = query.generation_metadata?.aliasOf;
    return {
      id: query.id,
      query: query.query,
      country: query.country,
      ...(typeof aliasOf === 'string' ? { aliasOf } : {}),
    };
  });
  const historyEntryById = new Map(historyEntries.map(entry => [entry.id, entry]));
  const historyFor = (query: QueryRecord) => {
    const entry = historyEntryById.get(query.id) || { id: query.id, query: query.query, country: query.country };
    return selectionHistoryFor(entry, historyEntries);
  };

  const admissions = new Map<number, QueryRecordAdmission>();
  let eligible: QueryRecord[] = [];
  for (const query of queries) {
    const admissionInfo = revalidateQueryRecordAdmission(query, { now: options.nowIso, history: historyFor(query) });
    admissions.set(query.id, admissionInfo);
    if (!admissionInfo.eligible) continue;
    if (admissionInfo.admission.tier === 'SPECULATIVE') continue;
    const failure = failureByQuery.get(query.id);
    const selectable = isQuerySelectable({
      record: query,
      now: options.nowIso,
      cooldownMinutes: options.cooldownMinutes,
      admission: admissionInfo.admission,
      primaryTermUses: primaryUsage.get(primaryKey(query.primary_term)) || 0,
      maxPrimaryUses: options.maxPrimaryUses,
      consecutiveFailures: failure?.consecutiveFailures,
      backoffUntil: failure?.backoffUntil,
    });
    if (!selectable.selectable) continue;
    eligible.push(query);
  }

  // Preserve the deterministic intent rotation as a diversity filter, never
  // as a score bonus.
  eligible = rotateAwayFromMostRecentIntent(eligible, queries);

  const familyQuota = new Map<string, number>();
  const sourceQuota = new Map<string, number>();
  const hierarchyCandidates: SelectorCandidate[] = [];
  const candidates: SelectorCandidate[] = [];
  let totalQuota = 0;
  for (const query of queries) {
    const admissionInfo = admissions.get(query.id);
    const counts = countsById.get(query.id) || emptyArmCounts();
    const spend = spendById.get(query.id) ?? counts.quotaUnits;
    totalQuota += spend;
    const admission = admissionInfo?.admission;
    const family = admission?.compositionFamily
      || (typeof query.generation_metadata?.compositionFamily === 'string' ? query.generation_metadata.compositionFamily : 'family:UNKNOWN');
    familyQuota.set(family, (familyQuota.get(family) || 0) + spend);
    const source = admission?.source || 'UNKNOWN';
    sourceQuota.set(source, (sourceQuota.get(source) || 0) + spend);
    // Hierarchy history covers every query in the accounting window, not only
    // the executable survivors. A cooling-down or share-capped sibling still
    // informs its family/country/market/language prior for the next surface.
    hierarchyCandidates.push(buildSelectorCandidate(query, admissionInfo, admission, counts));
  }
  for (const query of eligible) {
    const admissionInfo = admissions.get(query.id);
    const counts = countsById.get(query.id) || emptyArmCounts();
    const candidate = buildSelectorCandidate(query, admissionInfo, admissionInfo?.admission, counts);
    candidates.push(candidate);
  }
  // Shares are measured against the larger of observed spend and one day of
  // quota. Comparing only against query history would make a homogeneous pool
  // 100% of its own family/source and cap every candidate forever, even when
  // the family has spent a tiny fraction of the day.
  const budget = await getQueryPortfolioBudgetState();
  const shareBase = Math.max(1, totalQuota, budget.dailyQuotaUnits);
  const share = (rows: Map<string, number>, key: string): number => (rows.get(key) || 0) / shareBase;
  const familyShare = Object.fromEntries([...familyQuota.keys()].map(key => [key, share(familyQuota, key)]));
  const sourceShare = Object.fromEntries([...sourceQuota.keys()].map(key => [key, share(sourceQuota, key)]));
  const hierarchy = buildHierarchy(hierarchyCandidates);
  const coverageCells = [...new Set(candidates.map(coverageCellFor))];
  const coveredCells = [...new Set(candidates.filter(candidate => candidate.counts.runs > 0).map(coverageCellFor))];
  const context: SelectorContext = {
    country,
    now: options.nowIso,
    c: SELECTOR_C,
    maxIndex: MAX_SELECTION_INDEX,
    minSample: MIN_SELECTION_SAMPLE,
    portfolioRatio: options.portfolioRatio,
    totalDailyQuotaUnits: budget.dailyQuotaUnits,
    portfolioUnitsUsed: budget.portfolioUnitsUsed,
    familyShare,
    familyCap: options.familyCap,
    queryCap: 1,
    // Selection is invoked per country. The 16-country scheduler owns global
    // country rotation, so a per-call country share would always be 1.0 and
    // would block every candidate.
    countryShare: {},
    countryCap: 1,
    sourceShare,
    sourceCap: options.sourceCap,
    prior,
    halfLifeDays: DECAY_HALF_LIFE_DAYS,
    hierarchy,
    coverageCells,
    coveredCells,
  };
  const queriesById = new Map(queries.map(query => [query.id, query]));
  return { candidates, queriesById, admissions, context, decision: selectHierarchicalUcb(candidates, context) };
}

function buildSelectionResult(
  selected: QueryRecord,
  pool: SelectorPool,
  strategy: QuerySelectionResult['selectionStrategy'],
  reason: string,
  decision?: SelectorDecision,
): QuerySelectionResult | null {
  const admissionInfo = pool.admissions.get(selected.id);
  const ucb = decision?.index ?? pool.decision.index;
  if (ucb != null) selected = { ...selected, ucb_score: Number(ucb.toFixed(4)) };
  if (!selected) return null;
  return { queryRecord: selected,
    selectionStrategy: strategy,
    reason,
    selector: decision ?? pool.decision,
    admission: admissionInfo ? {
      hash: admissionInfo.admission.candidateHash,
      tier: admissionInfo.admission.tier,
      compositionFamily: admissionInfo.admission.compositionFamily,
      reasonCodes: admissionInfo.reasonCodes,
    } : undefined,
  };
}

// ==========================================
// 4. CANDIDATE QUERY GENERATOR
// ==========================================

/** Generates auditable, compact candidates led by retrieval atoms and proven terminology. */
export async function generateCandidateQueriesForCountry(
  country: string,
  count = 3,
  mode: 'EXPLORATION' | 'EXPLOITATION' | 'COLD_START' = 'EXPLORATION',
  options: { scopePromotionBasis?: 'PERSISTENT_SCOPE_SELECTION' | 'DIRECT_TARGET' } = {}
): Promise<QueryRecord[]> {
  await assertCountryAllowed(country, 'query_generation');
  const [vocabs, extractedTerms, existingQueries, provenTerminology, organicCandidates] = await Promise.all([
    getCountryVocabularies(),
    getExtractedVocabulary(country),
    getQueriesByCountry(country),
    getPlannerTerminology(country),
    getPublishedOrganicQueryCandidates(country)
  ]);
  const countryVocab = vocabs.find(v => v.country.toLowerCase() === country.toLowerCase());
  const planned = planDiverseQueries({
    country,
    count,
    countryVocabulary: countryVocab,
    learnedVocabulary: extractedTerms,
    existingQueries,
    provenTerminology,
    organicCandidates,
    mode,
    scopePromotionBasis: options.scopePromotionBasis
  });
  const newQueries: QueryRecord[] = [];
  for (const candidate of planned) {
    const record = await upsertQueryRecord({
      query: candidate.query,
      country,
      collection: 'EXPERIMENTAL',
      intent: candidate.intent,
      knowledgeTiers: candidate.knowledgeTiers,
      generationMode: candidate.generationMode,
      generationReason: candidate.generationReason,
      discoveryObjective: candidate.discoveryObjective,
      primaryTerm: candidate.primaryTerm,
      generationMetadata: candidate.metadata
    });
    newQueries.push(record);
  }
  return newQueries;
}

/** Typed rejection outcomes for the immutable Phase 8 -> Query Intelligence boundary. */
export type QueryIntelligenceAuthorizationCode =
  | 'COUNTRY_EXCLUDED'
  | 'PROPOSAL_FAMILY_UNSUPPORTED'
  | 'TARGET_NEIGHBORHOOD_MISMATCH'
  | 'NATIVE_TERM_MISSING'
  | 'EVIDENCE_CHECKSUM_MISSING'
  | 'QUERY_SPECIFICITY_REJECTED'
  | 'RETRIEVAL_ANCHOR_UNAVAILABLE'
  | 'CONSTRUCTED_QUERY_MISSING_NATIVE_TERM';

export type QueryIntelligenceAuthorizationOutcome =
  | { status: 'AUTHORIZED'; code: 'AUTHORIZED'; queryRecord: QueryRecord }
  | { status: 'REJECTED'; code: QueryIntelligenceAuthorizationCode; queryRecord: null }
  | { status: 'SYSTEM_ERROR'; code: 'AUTHORIZATION_SYSTEM_ERROR'; errorClass: string; queryRecord: null };

type CountryNativeAuthorizationInput = {
  country: string;
  decisionId: string;
  proposalId: string;
  targetNeighborhoodDimensions: DiscoveryNeighborhoodDimensions;
  proposalEvidenceSnapshot: Record<string, any>;
};

export type QueryIntelligenceAuthorizationInputResult =
  | { status: 'VALID'; nativeTerm: string; evidence: Record<string, any>; targetKey: string }
  | { status: 'REJECTED'; code: Exclude<QueryIntelligenceAuthorizationCode, 'COUNTRY_EXCLUDED' | 'RETRIEVAL_ANCHOR_UNAVAILABLE' | 'CONSTRUCTED_QUERY_MISSING_NATIVE_TERM'> };

/** Pure, database-free classification of the immutable proposal/evidence input. */
export function classifyCountryNativeAuthorizationInput(args: CountryNativeAuthorizationInput): QueryIntelligenceAuthorizationInputResult {
  const snapshot = args.proposalEvidenceSnapshot;
  if (!['COUNTRY_NATIVE', 'EXTERNAL_OSINT', 'CREATOR_DERIVED'].includes(snapshot?.proposalFamily)) {
    return { status: 'REJECTED', code: 'PROPOSAL_FAMILY_UNSUPPORTED' };
  }
  const targetKey = createNeighborhoodKey(args.targetNeighborhoodDimensions);
  if (snapshot.targetNeighborhoodKey !== targetKey ||
      createNeighborhoodKey(snapshot.targetDimensions as DiscoveryNeighborhoodDimensions) !== snapshot.targetNeighborhoodKey) {
    return { status: 'REJECTED', code: 'TARGET_NEIGHBORHOOD_MISMATCH' };
  }
  const evidence = snapshot.supportingEvidence || {};
  const nativeTerm = typeof evidence.nativeTerm === 'string' ? evidence.nativeTerm.trim()
    : typeof evidence.canonicalConcept === 'string' ? evidence.canonicalConcept.trim() : '';
  if (!nativeTerm) return { status: 'REJECTED', code: 'NATIVE_TERM_MISSING' };
  if (!evidence.evidenceChecksum) return { status: 'REJECTED', code: 'EVIDENCE_CHECKSUM_MISSING' };
  if (nativeTerm.normalize('NFKC').trim().replace(/\s+/g, ' ').split(/\s+/).length > 3) {
    return { status: 'REJECTED', code: 'QUERY_SPECIFICITY_REJECTED' };
  }
  return { status: 'VALID', nativeTerm, evidence, targetKey };
}

/** Governed Query Intelligence boundary for immutable Phase 8 concept allocations. */
export async function authorizeCountryNativeAllocationQuery(args: CountryNativeAuthorizationInput): Promise<QueryIntelligenceAuthorizationOutcome> {
  try {
    try {
      await assertCountryAllowed(args.country, 'query_generation');
    } catch (error: any) {
      if (error?.code === 'COUNTRY_EXCLUDED') {
        return { status: 'REJECTED', code: 'COUNTRY_EXCLUDED', queryRecord: null };
      }
      return { status: 'SYSTEM_ERROR', code: 'AUTHORIZATION_SYSTEM_ERROR', errorClass: 'COUNTRY_SCOPE_VALIDATION_FAILURE', queryRecord: null };
    }

    const inputResult = classifyCountryNativeAuthorizationInput(args);
    if (inputResult.status === 'REJECTED') return { status: 'REJECTED', code: inputResult.code, queryRecord: null };
    const { nativeTerm, evidence, targetKey } = inputResult;

    const vocabs = await getCountryVocabularies();
    const countryVocabulary = vocabs.find(v => v.country.toLowerCase() === args.country.toLowerCase());
    const planned = planCountryNativeProposalQuery({
      country: args.country,
      nativeTerm,
      countryVocabulary,
      targetIntent: args.targetNeighborhoodDimensions.queryIntent,
      language: typeof evidence.language === 'string' ? evidence.language : null,
      locale: typeof evidence.locale === 'string' ? evidence.locale : null,
      dominantLocale: typeof evidence.dominantLocale === 'string'
        ? evidence.dominantLocale
        : typeof evidence.dominant_locale === 'string' ? evidence.dominant_locale : null,
      allocationLineage: {
        decisionId: args.decisionId,
        proposalId: args.proposalId,
        targetNeighborhoodKey: targetKey,
        targetNeighborhoodDimensions: args.targetNeighborhoodDimensions,
        evidenceChecksum: evidence.evidenceChecksum,
        canonicalTermId: evidence.canonicalTermId ?? null,
        evidenceRevision: evidence.evidenceRevision ?? null
      }
    });
    if (!planned) return { status: 'REJECTED', code: 'RETRIEVAL_ANCHOR_UNAVAILABLE', queryRecord: null };
    if (!planned.query.normalize('NFKC').toLocaleLowerCase('en').includes(nativeTerm.normalize('NFKC').toLocaleLowerCase('en'))) {
      return { status: 'REJECTED', code: 'CONSTRUCTED_QUERY_MISSING_NATIVE_TERM', queryRecord: null };
    }

    const queryRecord = await upsertQueryRecord({
      query: planned.query,
      country: args.country,
      collection: 'EXPERIMENTAL',
      intent: planned.intent,
      knowledgeTiers: planned.knowledgeTiers,
      generationMode: planned.generationMode,
      generationReason: planned.generationReason,
      discoveryObjective: planned.discoveryObjective,
      primaryTerm: planned.primaryTerm,
      generationMetadata: planned.metadata
    });
    return { status: 'AUTHORIZED', code: 'AUTHORIZED', queryRecord };
  } catch (error: any) {
    return {
      status: 'SYSTEM_ERROR',
      code: 'AUTHORIZATION_SYSTEM_ERROR',
      errorClass: typeof error?.code === 'string' ? error.code : error?.name === 'Error' ? 'UNCLASSIFIED_ERROR' : 'AUTHORIZATION_FAILURE',
      queryRecord: null
    };
  }
}

/** Backward-compatible nullable adapter for non-diagnostic callers. */
export async function constructCountryNativeAllocationQuery(args: {
  country: string;
  decisionId: string;
  proposalId: string;
  targetNeighborhoodDimensions: DiscoveryNeighborhoodDimensions;
  proposalEvidenceSnapshot: Record<string, any>;
}): Promise<QueryRecord | null> {
  const outcome = await authorizeCountryNativeAllocationQuery(args);
  return outcome.status === 'AUTHORIZED' ? outcome.queryRecord : null;
}

// ==========================================
// 5. PERFORMANCE EVALUATOR & PROMOTION/DEMOTION
// ==========================================

/**
 * Evaluates the performance of a search query run and promotes/demotes collections
 */
export async function evaluateQueryPerformance(
  queryRecord: QueryRecord,
  metrics: QueryFunnelMetrics,
  attribution: { retrievalLane?: string; searchOrdering?: string; quotaConsumed?: number; queryRunId?: string; persist?: boolean } = {}
): Promise<{ performanceScore: number; newCollection: QueryCollection; summary: string }> {
  const performanceScore = metrics.performanceScore;
  // Q4c promotion guard: PROVEN is a lower-confidence-bound decision over
  // result-level, globally-new confirmed creators per quota, not a high
  // blended performance score. The current run is not yet committed when the
  // queue evaluates it, so completed prior runs are read from sighting truth
  // and the in-flight metrics are added as the newest observation.
  let promotionGuard: QueryPromotionGuard | undefined;
  if (performanceScore >= 60) {
    const priorRows = (await getQueryQualityRunRows(queryRecord.country))
      .filter(row => row.queryId === queryRecord.id && isRewardEligibleQuota(row.quotaUnits));
    // Use the run's own sighting truth: confirmed/quality are intersections
    // of persisted, globally-new, non-rejected, confirmed channels. The
    // aggregate counters can independently contain known confirmed traders
    // and new uncertain channels; min() would invent overlap that never
    // existed and could promote a zero-new-confirmation run.
    const currentReward = attribution.queryRunId
      ? await getQueryRunReward(attribution.queryRunId)
      : { confirmed: Math.min(metrics.tradingConfirmed, metrics.newChannels), quality: Math.min(metrics.qualityChannels, metrics.newChannels) };
    const currentRun = {
      ...currentReward,
      quotaUnits: Math.max(0, attribution.quotaConsumed || 0) / 100,
      ageDays: 0,
    };
    // Zero-quota runs are excluded from serving history, hierarchy learning
    // and the dashboard reward rate. They must not supply a promotion sample:
    // otherwise a free run could raise the per-100-quota LCB to PROVEN.
    const promotionRows = isRewardEligibleQuota(currentRun.quotaUnits)
      ? [...priorRows, currentRun]
      : priorRows;
    const counts = decayArmCounts(promotionRows, DECAY_HALF_LIFE_DAYS);
    const posterior = computePosterior(counts, empiricalPrior([counts], 0.05, 2), {}, SELECTOR_C, MAX_SELECTION_INDEX);
    promotionGuard = {
      completedRuns: counts.runs,
      lcb: promotionQualityScore(posterior),
      newConfirmedCreators: counts.confirmed,
      duplicateRatio: (metrics.evaluatedRawResults ?? metrics.rawResults) > 0
        ? metrics.duplicateResults / (metrics.evaluatedRawResults ?? metrics.rawResults)
        : 0,
      invalidQueryRate: 0,
      threshold: PROVEN_LCB_THRESHOLD,
      minRuns: PROVEN_MIN_COMPLETED_RUNS,
    };
  }
  const newCollection = selectQueryCollection(queryRecord.collection, queryRecord.times_executed, metrics, promotionGuard);

  if (isSeverelyContaminatedQuery(metrics)) {
    const vocabs = await getCountryVocabularies();
    const countryVocab = vocabs.find(v => v.country.toLowerCase() === queryRecord.country.toLowerCase());
    const reformulated = reformulatePollutedQuery({
      pollutedQuery: queryRecord.query,
      country: queryRecord.country,
      intent: queryRecord.intent,
      countryVocabulary: countryVocab
    });
    if (reformulated) {
      await upsertQueryRecord({
        query: reformulated.query,
        country: queryRecord.country,
        collection: 'EXPERIMENTAL',
        intent: reformulated.intent,
        knowledgeTiers: reformulated.knowledgeTiers,
        generationMode: reformulated.generationMode,
        generationReason: reformulated.generationReason,
        discoveryObjective: reformulated.discoveryObjective,
        primaryTerm: reformulated.primaryTerm,
        generationMetadata: reformulated.metadata
      }).catch(error => console.warn(`[QueryIntelligence] Reformulation failed for ${queryRecord.query}:`, error));
    }
  }

  if (attribution.persist !== false) {
    await updateQueryExecutionStats(queryRecord.id, {
      totalChannelsFound: metrics.distinctResults,
      uniqueChannelsFound: metrics.newChannels,
      qualityChannelsFound: metrics.qualityChannels,
      communityChannelsFound: metrics.communitiesDiscovered,
      avgQualityScore: metrics.averageQualityScore,
      performanceScore,
      newCollection
    });
    await attributeTerminologyPerformance(
      queryRecord,
      metrics,
      attribution.quotaConsumed || 0,
      attribution.retrievalLane,
      attribution.searchOrdering
    );
  }

  return {
    performanceScore,
    newCollection,
    summary: `Executed with score ${performanceScore}/100 (${metrics.newChannels} new, ${metrics.knownChannels} known, ${metrics.countryRejected} wrong-country, ${metrics.nonTrading} non-trading, ${metrics.uncertain} uncertain, ${metrics.tradingConfirmed} confirmed). Collection: ${newCollection}.`
  };
}
