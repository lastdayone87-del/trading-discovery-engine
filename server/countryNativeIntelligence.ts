import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getDb } from './db';
import { canonicalCountry } from './countryInference';

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
  codeSwitchTypes: string[];
  codeSwitchTypeCounts: Record<string, number>;
  rawObservationCount: number;
  nativeObservedCount: number;
  bootstrapSeedCount: number;
  translatedSeedCount: number;
  nativeObservedRatio: number;
  distinctCreatorCount: number;
  qualityCreatorCount: number;
  distinctCommunityCount: number;
  structuredEntityMatched: boolean;
  nativeEvidenceStatus: NativeEvidenceStatus;
  sourceProvenanceFamily: SourceProvenanceFamily;
  sourceProvenanceFamilies: string[];
  sourceProvenanceCounts: Record<string, number>;
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
 * Recursively canonicalizes a JSON object or array by sorting all keys at every level.
 */
function canonicalizeJSON(obj: any): any {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(canonicalizeJSON);
  }
  const sortedKeys = Object.keys(obj).sort();
  const result: Record<string, any> = {};
  for (const key of sortedKeys) {
    result[key] = canonicalizeJSON(obj[key]);
  }
  return result;
}

/**
 * Computes a deterministic checksum for an evidence payload using recursive canonical key sorting.
 */
export function computeEvidenceChecksum(evidence?: Record<string, unknown> | null): string {
  if (!evidence || Object.keys(evidence).length === 0) return '';
  const canonical = canonicalizeJSON(evidence);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').substring(0, 16);
}

/**
 * Computes a deterministic SHA-256 key for a native terminology observation to guarantee observation idempotency.
 * Binds canonical term ID, channel ID, video ID, observation type, native evidence status, provenance family,
 * and stable source evidence checksum/identity.
 */
export function computeObservationKey(params: {
  canonicalTermId: number;
  channelId?: string | null;
  videoId?: string | null;
  observationType: string;
  nativeEvidenceStatus?: string | null;
  sourceProvenanceFamily?: string | null;
  sourceEvidenceId?: string | null;
  evidence?: Record<string, unknown> | null;
}): string {
  const normChannel = (params.channelId || 'none').trim().toLowerCase();
  const normVideo = (params.videoId || 'none').trim().toLowerCase();
  const normType = params.observationType.trim().toUpperCase();
  const normStatus = (params.nativeEvidenceStatus || 'none').trim().toUpperCase();
  const normFamily = (params.sourceProvenanceFamily || 'none').trim().toUpperCase();

  const checksum = computeEvidenceChecksum(params.evidence);
  const evidenceId = (params.sourceEvidenceId || (checksum !== '' ? checksum : 'none')).trim().toLowerCase();

  const raw = `${params.canonicalTermId}|${normChannel}|${normVideo}|${normType}|${normStatus}|${normFamily}|${evidenceId}`;
  return createHash('sha256').update(raw).digest('hex');
}

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
 * Infers script for a term.
 */
export function inferScript(value: string): string {
  if (/\p{Script=Han}/u.test(value)) return 'Hani';
  if (/\p{Script=Katakana}|\p{Script=Hiragana}/u.test(value)) return 'Jpan';
  if (/\p{Script=Cyrillic}/u.test(value)) return 'Cyrl';
  if (/\p{Script=Arabic}/u.test(value)) return 'Arab';
  return /\p{Script=Latin}/u.test(value) ? 'Latn' : 'Zyyy';
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
 * Preserves distributions for provenance status, source family, and code-switching.
 * Does NOT treat legacy NULL provenance observations as native evidence.
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

  // Aggregate observations deterministically sorted by observed_at ASC, id ASC
  const obsRes = await runner.query(
    `SELECT
       o.id,
       o.source_creator_country,
       o.target_market_country,
       o.locale,
       o.is_code_switched,
       o.code_switch_type,
       o.native_evidence_status,
       o.source_provenance_family,
       o.community_fingerprint,
       o.source_channel_id,
       o.observed_at,
       c.trading_status,
       c.quality_score
     FROM terminology_observations o
     LEFT JOIN channels c ON c.channel_id = o.source_channel_id
     WHERE o.canonical_term_id = $1
     ORDER BY o.observed_at ASC, o.id ASC`,
    [canonicalTermId]
  );

  // Legacy/pre-Phase-10 rows carry NULL classification. They remain part of the
  // authoritative terminology lifecycle, but are neutral to this derived view.
  const rows = obsRes.rows.filter((row: any) => row.native_evidence_status !== null);
  const rawObservationCount = rows.length;

  if (rawObservationCount === 0) {
    // Remove a stale projection if classified evidence was retracted or corrected.
    await runner.query(
      'DELETE FROM country_native_evidence_projections WHERE canonical_term_id = $1',
      [canonicalTermId]
    );
    return null;
  }

  const allCreators = new Set<string>();
  const qualityCreators = new Set<string>();
  const creatorCountries = new Set<string>();
  const marketCountries = new Set<string>();
  const communities = new Set<string>();
  const locales = new Map<string, number>();

  let nativeObservedCount = 0;
  let bootstrapSeedCount = 0;
  let translatedSeedCount = 0;

  const provenanceCounts: Record<string, number> = {};
  const provenanceCountsByStatus: Record<string, Record<string, number>> = {};
  const codeSwitchTypeCounts: Record<string, number> = {};
  let codeSwitchedCount = 0;
  let structuredMatched = false;
  let maxObservedAtDate: Date | null = null;

  for (const r of rows) {
    if (r.observed_at) {
      const dt = new Date(r.observed_at);
      if (!maxObservedAtDate || dt > maxObservedAtDate) {
        maxObservedAtDate = dt;
      }
    }

    if (r.source_channel_id) {
      allCreators.add(r.source_channel_id);
      // Explicit Quality Creator Criteria: TRADING_CONFIRMED and quality_score >= 50
      if (r.trading_status === 'TRADING_CONFIRMED' && (r.quality_score || 0) >= 50) {
        qualityCreators.add(r.source_channel_id);
      }
    }

    if (r.source_creator_country) creatorCountries.add(canonicalCountry(r.source_creator_country));
    if (r.target_market_country) marketCountries.add(canonicalCountry(r.target_market_country));
    if (r.community_fingerprint) communities.add(r.community_fingerprint);

    if (r.locale && r.locale !== 'und') {
      locales.set(r.locale, (locales.get(r.locale) || 0) + 1);
    }

    if (r.is_code_switched) codeSwitchedCount++;

    const csType = r.code_switch_type || 'NONE';
    codeSwitchTypeCounts[csType] = (codeSwitchTypeCounts[csType] || 0) + 1;

    // Do NOT default NULL to NATIVE_OBSERVED! Legacy observations remain NULL / UNCLASSIFIED
    if (r.native_evidence_status === 'NATIVE_OBSERVED') nativeObservedCount++;
    else if (r.native_evidence_status === 'BOOTSTRAP_SEED') bootstrapSeedCount++;
    else if (r.native_evidence_status === 'TRANSLATED_SEED') translatedSeedCount++;

    const family = r.source_provenance_family || 'UNCLASSIFIED';
    provenanceCounts[family] = (provenanceCounts[family] || 0) + 1;
    if (r.native_evidence_status) {
      const byStatus = provenanceCountsByStatus[r.native_evidence_status] ||= {};
      byStatus[family] = (byStatus[family] || 0) + 1;
    }
  }

  // Stable sorted arrays
  const sortedCreatorCountries = Array.from(creatorCountries).sort();
  const sortedMarketCountries = Array.from(marketCountries).sort();
  const sortedCodeSwitchTypes = Object.keys(codeSwitchTypeCounts).sort();
  const sortedProvenanceFamilies = Object.keys(provenanceCounts).sort();

  // Determine dominant locale with deterministic tie-breaking (alphabetical)
  let dominantLocale = term.language || 'und';
  const sortedLocales = Array.from(locales.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  if (sortedLocales.length > 0) {
    dominantLocale = sortedLocales[0][0];
  }

  // Primary native evidence status (summary field)
  const nativeEvidenceStatus: NativeEvidenceStatus = nativeObservedCount > 0
    ? 'NATIVE_OBSERVED'
    : bootstrapSeedCount > 0
      ? 'BOOTSTRAP_SEED'
      : translatedSeedCount > 0
        ? 'TRANSLATED_SEED'
        : (() => { throw new Error('Classified native projection has no recognized evidence status.'); })();

  const nativeObservedRatio = rawObservationCount > 0 ? nativeObservedCount / rawObservationCount : 0.0;
  const codeSwitchRatio = rawObservationCount > 0 ? codeSwitchedCount / rawObservationCount : 0.0;
  const isCodeSwitched = codeSwitchRatio > 0.3;

  // Determine dominant code-switch type with deterministic tie-breaking
  let dominantCodeSwitchType: CodeSwitchType = 'NONE';
  const sortedCsTypes = Object.entries(codeSwitchTypeCounts)
    .filter(([t]) => t !== 'NONE')
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
  if (sortedCsTypes.length > 0) {
    dominantCodeSwitchType = sortedCsTypes[0][0] as CodeSwitchType;
  }

  // Primary source provenance family with deterministic tie-breaking
  let primaryFamily: SourceProvenanceFamily = 'CREATOR_METADATA';
  const winningProvenanceCounts = provenanceCountsByStatus[nativeEvidenceStatus] || {};
  const sortedFamilies = Object.entries(winningProvenanceCounts).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  if (sortedFamilies.length > 0 && sortedFamilies[0][0] !== 'UNCLASSIFIED') {
    primaryFamily = sortedFamilies[0][0] as SourceProvenanceFamily;
  }
  structuredMatched = Boolean(winningProvenanceCounts.STRUCTURED_LOCAL_ENTITY);

  const distinctCreatorCount = allCreators.size;
  const qualityCreatorCount = qualityCreators.size;
  const distinctCommunityCount = communities.size;

  // Native Proposal Eligibility Rule:
  // Requires native_observed_count >= 1 AND (qualityCreatorCount >= 2 OR structuredMatched) OR governed country_vocabularies / BOOTSTRAP_SEED
  const governedBootstrapEvidence = bootstrapSeedCount > 0 || Boolean(provenanceCounts.COUNTRY_VOCABULARY);
  const nativeProposalEligible =
    (nativeObservedCount >= 1 && (qualityCreatorCount >= 2 || structuredMatched)) ||
    governedBootstrapEvidence;

  // Calculate Native Confidence Score (0.0 to 1.0)
  let confidence = 0.20; // Base
  if (structuredMatched) confidence += 0.30;
  if (nativeObservedCount >= 1) confidence += 0.20;
  confidence += Math.min(0.30, qualityCreatorCount * 0.10);
  confidence += Math.min(0.10, distinctCommunityCount * 0.05);

  // Single creator cap constraint: If qualityCreatorCount <= 1 and not structured, cap native proposal confidence at 0.45
  if (qualityCreatorCount <= 1 && !structuredMatched && nativeEvidenceStatus !== 'BOOTSTRAP_SEED') {
    confidence = Math.min(0.45, confidence);
  }

  const finalConfidence = Math.min(0.95, Math.max(0.0, confidence));
  const derivedLastObservedAt = maxObservedAtDate ? maxObservedAtDate.toISOString() : new Date().toISOString();
  const nowUpdatedAt = new Date().toISOString();

  const projection: CountryNativeEvidenceProjection = {
    canonicalTermId,
    conceptId: term.concept_id || null,
    country: term.country,
    dominantLocale,
    observedCreatorCountries: sortedCreatorCountries,
    observedMarketCountries: sortedMarketCountries,
    codeSwitchRatio,
    isCodeSwitched,
    codeSwitchType: dominantCodeSwitchType,
    codeSwitchTypes: sortedCodeSwitchTypes,
    codeSwitchTypeCounts,
    rawObservationCount,
    nativeObservedCount,
    bootstrapSeedCount,
    translatedSeedCount,
    nativeObservedRatio,
    distinctCreatorCount,
    qualityCreatorCount,
    distinctCommunityCount,
    structuredEntityMatched: structuredMatched,
    nativeEvidenceStatus,
    sourceProvenanceFamily: primaryFamily,
    sourceProvenanceFamilies: sortedProvenanceFamilies,
    sourceProvenanceCounts: provenanceCounts,
    nativeConfidenceScore: finalConfidence,
    nativeProposalEligible,
    lastObservedAt: derivedLastObservedAt,
    updatedAt: nowUpdatedAt
  };

  // Upsert into country_native_evidence_projections idempotently
  await runner.query(
    `INSERT INTO country_native_evidence_projections (
       canonical_term_id, concept_id, country, dominant_locale,
       observed_creator_countries, observed_market_countries,
       code_switch_ratio, is_code_switched, code_switch_type,
       code_switch_types, code_switch_type_counts,
       raw_observation_count, native_observed_count, bootstrap_seed_count,
       translated_seed_count, native_observed_ratio,
       distinct_creator_count, quality_creator_count, distinct_community_count,
       structured_entity_matched, native_evidence_status, source_provenance_family,
       source_provenance_families, source_provenance_counts,
       native_confidence_score, native_proposal_eligible,
       last_observed_at, updated_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
       $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28
     )
     ON CONFLICT (canonical_term_id) DO UPDATE SET
       concept_id = EXCLUDED.concept_id,
       country = EXCLUDED.country,
       dominant_locale = EXCLUDED.dominant_locale,
       observed_creator_countries = EXCLUDED.observed_creator_countries,
       observed_market_countries = EXCLUDED.observed_market_countries,
       code_switch_ratio = EXCLUDED.code_switch_ratio,
       is_code_switched = EXCLUDED.is_code_switched,
       code_switch_type = EXCLUDED.code_switch_type,
       code_switch_types = EXCLUDED.code_switch_types,
       code_switch_type_counts = EXCLUDED.code_switch_type_counts,
       raw_observation_count = EXCLUDED.raw_observation_count,
       native_observed_count = EXCLUDED.native_observed_count,
       bootstrap_seed_count = EXCLUDED.bootstrap_seed_count,
       translated_seed_count = EXCLUDED.translated_seed_count,
       native_observed_ratio = EXCLUDED.native_observed_ratio,
       distinct_creator_count = EXCLUDED.distinct_creator_count,
       quality_creator_count = EXCLUDED.quality_creator_count,
       distinct_community_count = EXCLUDED.distinct_community_count,
       structured_entity_matched = EXCLUDED.structured_entity_matched,
       native_evidence_status = EXCLUDED.native_evidence_status,
       source_provenance_family = EXCLUDED.source_provenance_family,
       source_provenance_families = EXCLUDED.source_provenance_families,
       source_provenance_counts = EXCLUDED.source_provenance_counts,
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
      JSON.stringify(projection.codeSwitchTypes),
      JSON.stringify(projection.codeSwitchTypeCounts),
      projection.rawObservationCount,
      projection.nativeObservedCount,
      projection.bootstrapSeedCount,
      projection.translatedSeedCount,
      projection.nativeObservedRatio,
      projection.distinctCreatorCount,
      projection.qualityCreatorCount,
      projection.distinctCommunityCount,
      projection.structuredEntityMatched,
      projection.nativeEvidenceStatus,
      projection.sourceProvenanceFamily,
      JSON.stringify(projection.sourceProvenanceFamilies),
      JSON.stringify(projection.sourceProvenanceCounts),
      projection.nativeConfidenceScore,
      projection.nativeProposalEligible,
      projection.lastObservedAt,
      projection.updatedAt
    ]
  );

  return projection;
}

/**
 * @deprecated Use observeTerminology() in server/terminologyIntelligence.ts.
 * Delegated write helper ensuring all observations write through observeTerminology().
 */
export async function recordNativeTerminologyObservation(args: {
  term: string;
  country: string;
  sourceCreatorCountry?: string | null;
  targetMarketCountry?: string | null;
  locale?: string;
  channelId?: string;
  videoId?: string;
  sourceEvidenceId?: string;
  observationType: 'CHANNEL_NAME' | 'VIDEO_TITLE' | 'DESCRIPTION' | 'ENRICHMENT' | 'HUMAN_APPROVED_CHANNEL';
  nativeEvidenceStatus?: NativeEvidenceStatus;
  sourceProvenanceFamily?: SourceProvenanceFamily;
  evidence?: Record<string, unknown>;
}, clientOverride?: Queryable): Promise<number | null> {
  const { observeTerminology } = await import('./terminologyIntelligence');
  return observeTerminology({
    term: args.term,
    country: args.country,
    termType: 'TERMINOLOGY',
    observationType: args.observationType,
    channelId: args.channelId,
    videoId: args.videoId,
    sourceCreatorCountry: args.sourceCreatorCountry,
    targetMarketCountry: args.targetMarketCountry,
    locale: args.locale,
    nativeEvidenceStatus: args.nativeEvidenceStatus,
    sourceProvenanceFamily: args.sourceProvenanceFamily,
    sourceEvidenceId: args.sourceEvidenceId,
    evidence: args.evidence
  }, clientOverride);
}

/**
 * Tracks query execution yield and coverage expansion gains by native provenance type.
 */
export async function attributeCountryNativePerformance(args: {
  attributionKey: string;
  canonicalTermId?: number | null;
  proposalId?: string | null;
  allocationDecisionId?: string | null;
  queryId?: number | null;
  queryRunId?: string | null;
  country: string;
  nativeEvidenceStatus: NativeEvidenceStatus;
  sourceProvenanceFamily: SourceProvenanceFamily;
  isCodeSwitched?: boolean;
  rawResults?: number;
  uniqueCreators?: number;
  newCreators?: number;
  relevantNewCreators?: number;
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
       attribution_key, canonical_term_id, proposal_id, allocation_decision_id,
       query_id, query_run_id, country,
       native_evidence_status, source_provenance_family, is_code_switched,
       executed_at, raw_results, unique_creators, new_creators, relevant_new_creators,
       quality_creators, confirmed_trading_creators, quota_consumed,
       yield_score, coverage_expansion_gain
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11, $12, $13, $14, $15, $16, $17, $18, $19)
     ON CONFLICT (attribution_key) DO NOTHING`,
    [
      args.attributionKey,
      args.canonicalTermId || null,
      args.proposalId || null,
      args.allocationDecisionId || null,
      args.queryId || null,
      args.queryRunId || null,
      canonicalCountry(args.country),
      args.nativeEvidenceStatus,
      args.sourceProvenanceFamily,
      Boolean(args.isCodeSwitched),
      args.rawResults || 0,
      args.uniqueCreators || 0,
      args.newCreators || 0,
      args.relevantNewCreators || 0,
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
