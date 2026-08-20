import type { Pool, PoolClient } from 'pg';
import { getDb } from './db';
import { normalizeTerm, inferScript } from './terminologyIntelligence';

type Queryable = Pool | PoolClient | { query: (sql: string, params?: any[]) => Promise<any> };

export type NativeEvidenceStatus = 'NATIVE_OBSERVED' | 'BOOTSTRAP_SEED' | 'TRANSLATED_SEED';

export type SourceProvenanceFamily =
  | 'CREATOR_METADATA'
  | 'STRUCTURED_LOCAL_ENTITY'
  | 'COUNTRY_VOCABULARY'
  | 'STATIC_BOOTSTRAP'
  | 'TRANSLATED_QUERY';

export type CodeSwitchType =
  | 'NONE'
  | 'NATIVE_DOMINANT_ENGLISH_FINANCE'
  | 'ENGLISH_DOMINANT_NATIVE_MARKET'
  | 'MIXED_SCRIPT_TERMINOLOGY';

export interface CountryNativeEvidenceProjection {
  id?: string;
  canonicalTermId: number;
  conceptId?: string | null;
  country: string;
  dominantLocale: string;
  observedCreatorCountries: string[];
  observedMarketCountries: string[];
  codeSwitchRatio: number;
  isCodeSwitched: boolean;
  codeSwitchType: CodeSwitchType | string | null;
  rawObservationCount: number;
  distinctCreatorCount: number;
  qualityCreatorCount: number;
  distinctCommunityCount: number;
  structuredEntityMatched: boolean;
  nativeEvidenceStatus: NativeEvidenceStatus;
  sourceProvenanceFamily: SourceProvenanceFamily;
  nativeConfidenceScore: number;
  nativeProposalEligible: boolean;
  lastObservedAt: string;
  updatedAt: string;
}

const GENERIC_STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'you', 'your', 'from', 'have',
  'de', 'da', 'do', 'com', 'para', 'uma', 'por', 'que', 'em', 'os', 'as',
  'und', 'mit', 'das', 'dem', 'der', 'die', 'für', 'ein', 'eine', 'einen',
  'les', 'des', 'dans', 'pour', 'sur', 'une', 'avec', 'to', 'my', 'in', 'on', 'at', 'by'
]);

const SPONSOR_OR_AFFILIATE_PATTERNS = [
  /https?:\/\//i,
  /www\./i,
  /\.com|\.org|\.net|\.io|\.br|\.de|\.jp|\.uk/i,
  /code|cupom|discount|desconto|rabatt|promo/i,
  /instagram|telegram|whatsapp|twitter|x\.com|facebook|tiktok|discord/i,
  /giveaway|sorteio|vlog|lifestyle|affiliate|patroc[ií]nio/i,
  /subscribe|channel|video|watch|like|follow|link|below|inscreva|canal|curta|abonnieren|abonnent/i
];

/**
 * Deterministically normalizes a candidate native term.
 * Preserves NFKC forms, diacritics/accents, ticker symbols, and multi-word terms.
 */
export function normalizeNativeTerm(value: string): string {
  if (!value) return '';
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('en');
}

/**
 * Noise & boilerplate filter for native market terms.
 * Downweights/rejects generic stopwords, URLs, affiliate links, social handles, sponsor text.
 */
export function isNoiseOrBoilerplate(term: string): boolean {
  const norm = normalizeNativeTerm(term);
  if (!norm || norm.length < 2 || norm.length > 80) return true;

  // Single word or all-words stopwords
  const words = norm.split(/\s+/);
  if (words.every(w => GENERIC_STOPWORDS.has(w))) return true;

  // Pattern matches (URLs, Handles, Promos, Subscribe boilerplate)
  for (const pattern of SPONSOR_OR_AFFILIATE_PATTERNS) {
    if (pattern.test(norm)) return true;
  }

  // Pure digits unless valid index or contract form
  if (/^\d+$/.test(norm) && norm.length < 3) return true;

  return false;
}

/**
 * Identifies code-switching evidence across language and script.
 */
export function detectCodeSwitching(text: string, defaultLanguage = 'und'): {
  isCodeSwitched: boolean;
  codeSwitchType: CodeSwitchType;
  dominantLanguage: string;
  termLanguage: string;
} {
  const norm = normalizeNativeTerm(text);

  const hasLatin = /\p{Script=Latin}/u.test(text);
  const hasHanOrKanaOrHangul = /\p{Script=Han}|\p{Script=Katakana}|\p{Script=Hiragana}|\p{Script=Hangul}/u.test(text);
  const hasCyrillic = /\p{Script=Cyrillic}/u.test(text);
  const hasArabic = /\p{Script=Arabic}/u.test(text);

  if ((hasHanOrKanaOrHangul || hasCyrillic || hasArabic) && hasLatin) {
    return {
      isCodeSwitched: true,
      codeSwitchType: 'MIXED_SCRIPT_TERMINOLOGY',
      dominantLanguage: defaultLanguage,
      termLanguage: 'en'
    };
  }

  // English trading terms embedded in non-English text
  const englishFinanceTokens = ['scalping', 'daytrade', 'breakout', 'swing', 'options', 'futures', 'forex', 'rsi', 'macd', 'setup', 'trader'];
  const words = norm.split(/\s+/);
  const hasEnglishToken = words.some(w => englishFinanceTokens.includes(w));
  const hasNativeTokens = words.some(w => !englishFinanceTokens.includes(w) && w.length >= 3);

  if (hasEnglishToken && hasNativeTokens && defaultLanguage !== 'en' && defaultLanguage !== 'und') {
    return {
      isCodeSwitched: true,
      codeSwitchType: 'NATIVE_DOMINANT_ENGLISH_FINANCE',
      dominantLanguage: defaultLanguage,
      termLanguage: 'en'
    };
  }

  return {
    isCodeSwitched: false,
    codeSwitchType: 'NONE',
    dominantLanguage: defaultLanguage,
    termLanguage: defaultLanguage
  };
}

/**
 * Recomputes native evidence projections deterministically from `terminology_observations` and `channels`.
 * Ensures full idempotency and idempotency retry safety.
 */
export async function recomputeNativeEvidenceProjection(
  canonicalTermId: number,
  clientOverride?: Queryable
): Promise<CountryNativeEvidenceProjection | null> {
  const runner = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return null;

  // Fetch canonical term
  const termRes = await runner.query(
    `SELECT id, canonical_term, normalized_term, country, language, concept_id
     FROM canonical_trading_terms
     WHERE id = $1`,
    [canonicalTermId]
  );
  if (!termRes.rows[0]) return null;
  const term = termRes.rows[0];

  // Aggregate observations joined with channel trading status for true quality creator counting
  const obsRes = await runner.query(
    `SELECT
       o.source_creator_country,
       o.target_market_country,
       o.locale,
       o.is_code_switched,
       o.native_evidence_status,
       o.source_provenance_family,
       o.community_fingerprint,
       o.source_channel_id,
       c.trading_status,
       c.quality_score
     FROM terminology_observations o
     LEFT JOIN channels c ON c.channel_id = o.source_channel_id
     WHERE o.canonical_term_id = $1`,
    [canonicalTermId]
  );

  const rows = obsRes.rows;
  const rawObservationCount = rows.length;

  if (rawObservationCount === 0) {
    return null;
  }

  // Calculate distinct creator count and quality creator count
  const allCreators = new Set<string>();
  const qualityCreators = new Set<string>();
  const creatorCountries = new Set<string>();
  const marketCountries = new Set<string>();
  const communities = new Set<string>();
  const locales = new Map<string, number>();

  let codeSwitchedCount = 0;
  let structuredMatched = false;
  let hasNativeObserved = false;
  let hasBootstrap = false;
  let hasTranslated = false;
  let primaryFamily: SourceProvenanceFamily = 'CREATOR_METADATA';

  for (const r of rows) {
    if (r.source_channel_id) {
      allCreators.add(r.source_channel_id);
      // Explicit Quality Creator Criteria: TRADING_CONFIRMED and quality_score >= 50
      if (r.trading_status === 'TRADING_CONFIRMED' && (r.quality_score || 0) >= 50) {
        qualityCreators.add(r.source_channel_id);
      }
    }

    if (r.source_creator_country) creatorCountries.add(r.source_creator_country.toUpperCase());
    if (r.target_market_country) marketCountries.add(r.target_market_country.toUpperCase());
    if (r.community_fingerprint) communities.add(r.community_fingerprint);

    if (r.locale && r.locale !== 'und') {
      locales.set(r.locale, (locales.get(r.locale) || 0) + 1);
    }

    if (r.is_code_switched) codeSwitchedCount++;

    if (r.native_evidence_status === 'NATIVE_OBSERVED') hasNativeObserved = true;
    if (r.native_evidence_status === 'BOOTSTRAP_SEED') hasBootstrap = true;
    if (r.native_evidence_status === 'TRANSLATED_SEED') hasTranslated = true;

    if (r.source_provenance_family === 'STRUCTURED_LOCAL_ENTITY') {
      structuredMatched = true;
      primaryFamily = 'STRUCTURED_LOCAL_ENTITY';
    } else if (r.source_provenance_family === 'COUNTRY_VOCABULARY') {
      primaryFamily = 'COUNTRY_VOCABULARY';
    }
  }

  // Determine dominant locale
  let dominantLocale = term.language || 'und';
  let maxLocaleCount = 0;
  for (const [loc, cnt] of locales.entries()) {
    if (cnt > maxLocaleCount) {
      maxLocaleCount = cnt;
      dominantLocale = loc;
    }
  }

  // Primary native evidence status
  const nativeEvidenceStatus: NativeEvidenceStatus = hasNativeObserved
    ? 'NATIVE_OBSERVED'
    : hasBootstrap
      ? 'BOOTSTRAP_SEED'
      : hasTranslated
        ? 'TRANSLATED_SEED'
        : 'NATIVE_OBSERVED';

  const codeSwitchRatio = rawObservationCount > 0 ? codeSwitchedCount / rawObservationCount : 0.0;
  const isCodeSwitched = codeSwitchRatio > 0.3;
  const codeSwitchType: CodeSwitchType = isCodeSwitched ? 'NATIVE_DOMINANT_ENGLISH_FINANCE' : 'NONE';

  const distinctCreatorCount = allCreators.size;
  const qualityCreatorCount = qualityCreators.size;
  const distinctCommunityCount = communities.size;

  // Calculate Native Proposal Eligibility:
  // Must have qualityCreatorCount >= 2 OR structuredEntityMatched = true OR originate from governed country_vocabularies / BOOTSTRAP_SEED
  const nativeProposalEligible =
    qualityCreatorCount >= 2 ||
    structuredMatched ||
    nativeEvidenceStatus === 'BOOTSTRAP_SEED' ||
    primaryFamily === 'COUNTRY_VOCABULARY';

  // Calculate Native Confidence Score (0.0 to 1.0)
  let confidence = 0.20; // Base
  if (structuredMatched) confidence += 0.30;
  if (nativeEvidenceStatus === 'NATIVE_OBSERVED') confidence += 0.20;
  confidence += Math.min(0.30, qualityCreatorCount * 0.10);
  confidence += Math.min(0.10, distinctCommunityCount * 0.05);

  // Single creator cap constraint: If qualityCreatorCount <= 1 and not structured, cap native proposal confidence at 0.45
  if (qualityCreatorCount <= 1 && !structuredMatched && nativeEvidenceStatus !== 'BOOTSTRAP_SEED') {
    confidence = Math.min(0.45, confidence);
  }

  const finalConfidence = Math.min(0.95, Math.max(0.0, confidence));
  const now = new Date().toISOString();

  const projection: CountryNativeEvidenceProjection = {
    canonicalTermId,
    conceptId: term.concept_id || null,
    country: term.country,
    dominantLocale,
    observedCreatorCountries: Array.from(creatorCountries),
    observedMarketCountries: Array.from(marketCountries),
    codeSwitchRatio,
    isCodeSwitched,
    codeSwitchType,
    rawObservationCount,
    distinctCreatorCount,
    qualityCreatorCount,
    distinctCommunityCount,
    structuredEntityMatched: structuredMatched,
    nativeEvidenceStatus,
    sourceProvenanceFamily: primaryFamily,
    nativeConfidenceScore: finalConfidence,
    nativeProposalEligible,
    lastObservedAt: now,
    updatedAt: now
  };

  // Upsert into country_native_evidence_projections idempotently
  await runner.query(
    `INSERT INTO country_native_evidence_projections (
       canonical_term_id, concept_id, country, dominant_locale,
       observed_creator_countries, observed_market_countries,
       code_switch_ratio, is_code_switched, code_switch_type,
       raw_observation_count, distinct_creator_count, quality_creator_count,
       distinct_community_count, structured_entity_matched,
       native_evidence_status, source_provenance_family,
       native_confidence_score, native_proposal_eligible,
       last_observed_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
     ON CONFLICT (canonical_term_id) DO UPDATE SET
       concept_id = EXCLUDED.concept_id,
       country = EXCLUDED.country,
       dominant_locale = EXCLUDED.dominant_locale,
       observed_creator_countries = EXCLUDED.observed_creator_countries,
       observed_market_countries = EXCLUDED.observed_market_countries,
       code_switch_ratio = EXCLUDED.code_switch_ratio,
       is_code_switched = EXCLUDED.is_code_switched,
       code_switch_type = EXCLUDED.code_switch_type,
       raw_observation_count = EXCLUDED.raw_observation_count,
       distinct_creator_count = EXCLUDED.distinct_creator_count,
       quality_creator_count = EXCLUDED.quality_creator_count,
       distinct_community_count = EXCLUDED.distinct_community_count,
       structured_entity_matched = EXCLUDED.structured_entity_matched,
       native_evidence_status = EXCLUDED.native_evidence_status,
       source_provenance_family = EXCLUDED.source_provenance_family,
       native_confidence_score = EXCLUDED.native_confidence_score,
       native_proposal_eligible = EXCLUDED.native_proposal_eligible,
       last_observed_at = EXCLUDED.last_observed_at,
       updated_at = EXCLUDED.updated_at`,
    [
      canonicalTermId,
      projection.conceptId,
      projection.country,
      projection.dominantLocale,
      JSON.stringify(projection.observedCreatorCountries),
      JSON.stringify(projection.observedMarketCountries),
      projection.codeSwitchRatio,
      projection.isCodeSwitched,
      projection.codeSwitchType,
      projection.rawObservationCount,
      projection.distinctCreatorCount,
      projection.qualityCreatorCount,
      projection.distinctCommunityCount,
      projection.structuredEntityMatched,
      projection.nativeEvidenceStatus,
      projection.sourceProvenanceFamily,
      projection.nativeConfidenceScore,
      projection.nativeProposalEligible,
      projection.lastObservedAt,
      projection.updatedAt
    ]
  );

  return projection;
}

/**
 * Extracts and records native candidate market terms from channel/video metadata.
 */
export async function recordNativeTerminologyObservation(args: {
  term: string;
  country: string;
  sourceCreatorCountry?: string;
  targetMarketCountry?: string;
  locale?: string;
  channelId?: string;
  videoId?: string;
  observationType: 'CHANNEL_NAME' | 'VIDEO_TITLE' | 'DESCRIPTION' | 'ENRICHMENT' | 'HUMAN_APPROVED_CHANNEL';
  nativeEvidenceStatus?: NativeEvidenceStatus;
  sourceProvenanceFamily?: SourceProvenanceFamily;
  evidence?: Record<string, unknown>;
}, clientOverride?: Queryable): Promise<number | null> {
  const norm = normalizeNativeTerm(args.term);
  if (isNoiseOrBoilerplate(args.term)) return null;

  const runner = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return null;

  const canonical = args.term.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const codeSwitching = detectCodeSwitching(canonical, args.locale ? args.locale.split('-')[0] : 'und');

  // Insert or fetch canonical trading term
  const saved = await runner.query(
    `INSERT INTO canonical_trading_terms(canonical_term, normalized_term, country, language, script, term_type, first_observed_at, last_observed_at)
     VALUES($1, $2, $3, $4, $5, 'TERMINOLOGY', now(), now())
     ON CONFLICT(country, normalized_term) DO UPDATE SET last_observed_at = now()
     RETURNING id`,
    [canonical, norm, args.country.toUpperCase(), codeSwitching.dominantLanguage, inferScript(canonical)]
  );

  const termId = Number(saved.rows[0].id);

  const creatorCountry = (args.sourceCreatorCountry || args.country).toUpperCase();
  const marketCountry = (args.targetMarketCountry || args.country).toUpperCase();
  const evidenceStatus = args.nativeEvidenceStatus || 'NATIVE_OBSERVED';
  const provenanceFamily = args.sourceProvenanceFamily || 'CREATOR_METADATA';

  // Insert observation into terminology_observations
  await runner.query(
    `INSERT INTO terminology_observations (
       canonical_term_id, source_channel_id, source_video_id, observation_type,
       source_creator_country, target_market_country, locale, is_code_switched,
       native_language, native_evidence_status, source_provenance_family, code_switch_type,
       evidence
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      termId,
      args.channelId || null,
      args.videoId || null,
      args.observationType,
      creatorCountry,
      marketCountry,
      args.locale || 'und',
      codeSwitching.isCodeSwitched,
      codeSwitching.termLanguage,
      evidenceStatus,
      provenanceFamily,
      codeSwitching.codeSwitchType,
      JSON.stringify(args.evidence || {})
    ]
  );

  // Recompute native evidence projection idempotently
  await recomputeNativeEvidenceProjection(termId, runner);

  return termId;
}

/**
 * Tracks query execution yield and coverage expansion gains by native provenance type.
 */
export async function attributeCountryNativePerformance(args: {
  canonicalTermId: number;
  queryId?: number | null;
  queryRunId?: string | null;
  country: string;
  nativeEvidenceStatus: NativeEvidenceStatus;
  sourceProvenanceFamily: SourceProvenanceFamily;
  isCodeSwitched?: boolean;
  rawResults?: number;
  uniqueCreators?: number;
  newCreators?: number;
  qualityCreators?: number;
  confirmedTradingCreators?: number;
  quotaConsumed?: number;
  yieldScore?: number;
  coverageExpansionGain?: number;
}, clientOverride?: Queryable): Promise<void> {
  const runner = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return;

  await runner.query(
    `INSERT INTO country_native_performance_attribution (
       canonical_term_id, query_id, query_run_id, country,
       native_evidence_status, source_provenance_family, is_code_switched,
       executed_at, raw_results, unique_creators, new_creators,
       quality_creators, confirmed_trading_creators, quota_consumed,
       yield_score, coverage_expansion_gain
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      args.canonicalTermId,
      args.queryId || null,
      args.queryRunId || null,
      args.country.toUpperCase(),
      args.nativeEvidenceStatus,
      args.sourceProvenanceFamily,
      Boolean(args.isCodeSwitched),
      args.rawResults || 0,
      args.uniqueCreators || 0,
      args.newCreators || 0,
      args.qualityCreators || 0,
      args.confirmedTradingCreators || 0,
      args.quotaConsumed || 0,
      args.yieldScore || 0.0,
      args.coverageExpansionGain || 0.0
    ]
  );
}

/**
 * Returns country-native coverage diagnostics.
 */
export async function getCountryNativeCoverageDiagnostics(country?: string, clientOverride?: Queryable): Promise<Record<string, unknown>[]> {
  const runner = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return [];

  const res = await runner.query(
    `SELECT * FROM country_native_coverage_diagnostics
     WHERE ($1::text IS NULL OR UPPER(country) = UPPER($1))`,
    [country || null]
  );
  return res.rows;
}
