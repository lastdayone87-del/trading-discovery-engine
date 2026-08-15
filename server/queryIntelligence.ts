import { GoogleGenAI } from '@google/genai';
import { ChannelRecord, CountryVocabulary, QualityScoreBreakdown, QueryRecord, QueryCollection, ExtractedTermRecord } from '../src/types';
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
  getAppSetting
} from './db';
import { assertCountryAllowed } from './countryExclusion';
import { limitRepeatedPrimaryTerms, planDiverseQueries, queriesOutsideCooldown, rotateAwayFromMostRecentIntent, reformulatePollutedQuery } from './queryPlanner';
import { selectQueryCollection, isSeverelyContaminatedQuery, type QueryFunnelMetrics } from './queryPerformance';
import { attributeTerminologyPerformance, getPlannerTerminology, observeTerminology } from './terminologyIntelligence';
import { executeProviderCall } from './providerResilience';
import { appendProviderCallEvent } from './db';
import { getPublishedOrganicQueryCandidates } from './organicQueryExpansion';

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
export async function extractVocabularyFromCreator(
  channel: ChannelRecord,
  videoTitles: string[] = [],
  description: string = '',
  humanApproved = false
): Promise<ExtractedTermRecord[]> {
  const extracted: ExtractedTermRecord[] = [];
  const ai = getAIClient();

  if (!channel.country || channel.country === 'Unknown' || channel.trading_status !== 'TRADING_CONFIRMED') return [];

  // 1. Rule-based extraction of instruments & terminology
  const text = `${channel.channel_name} ${description} ${videoTitles.join(' ')}`;
  const textLower = text.toLowerCase();

  // Known instruments & phrases pattern matching
  const potentialInstruments = ['NQ', 'ES', 'DAX', 'FDAX', 'CAC 40', 'IBEX 35', 'FTSE 100', 'AEX', 'BTC', 'ETH', 'EURUSD', 'GBPUSD', 'Gold', 'WTI Crude', 'S&P 500', 'Nasdaq'];
  for (const inst of potentialInstruments) {
    if (textLower.includes(inst.toLowerCase())) {
      await saveExtractedTerm(channel.country, inst, 'instrument', channel.channel_id);
      const sources: Array<{ value: string; type: 'CHANNEL_NAME' | 'VIDEO_TITLE' | 'DESCRIPTION' }> = [
        { value: channel.channel_name, type: 'CHANNEL_NAME' },
        ...videoTitles.map(value => ({ value, type: 'VIDEO_TITLE' as const })),
        { value: description, type: 'DESCRIPTION' }
      ];
      for (const source of sources.filter(item => item.value.toLocaleLowerCase('en').includes(inst.toLocaleLowerCase('en')))) {
        await observeTerminology({ term: inst, country: channel.country, termType: 'INSTRUMENT', observationType: humanApproved ? 'HUMAN_APPROVED_CHANNEL' : source.type, channelId: channel.channel_id, humanApproved, communityFingerprint: channel.discord_invite || undefined, evidence: { extractor: 'KNOWN_INSTRUMENT_V1', sourceType: source.type } });
      }
    }
  }

  // 2. Deep Gemini Extraction if API Key is configured
  if (ai && (videoTitles.length > 0 || description.length > 20)) {
    try {
      const prompt = `Analyze this YouTube trading channel and recent video titles for country "${channel.country}".
Channel Name: "${channel.channel_name}"
Description: "${description}"
Recent Titles:
${videoTitles.map(t => `- ${t}`).join('\n')}

Identify any localized, native trading terminology, popular financial instruments, market phrases, or content formats specific to traders in ${channel.country}.
Return ONLY a valid JSON object with format:
{
  "terminology": ["term1", "term2"],
  "instruments": ["inst1"],
  "phrases": ["phrase1"],
  "formats": ["format1"]
}`;

      const response = await callGeminiSafe(() => executeProviderCall({context:{provider:'gemini',operation:'vocabulary-extraction'},timeoutMs:Number(process.env.GEMINI_PROVIDER_TIMEOUT_MS||'45000'),enabled:process.env.PROVIDER_DEADLINES_ENABLED==='true',emit:appendProviderCallEvent,call:() => ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: prompt
      })}));

      const resText = response.text || '';
      const jsonMatch = resText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.terminology)) {
          for (const t of parsed.terminology) {
            await saveExtractedTerm(channel.country, t, 'terminology', channel.channel_id);
            await observeTerminology({ term: String(t), country: channel.country, termType: 'TERMINOLOGY', observationType: humanApproved ? 'HUMAN_APPROVED_CHANNEL' : 'ENRICHMENT', channelId: channel.channel_id, humanApproved, communityFingerprint: channel.discord_invite || undefined, evidence: { extractor: 'GEMINI' } });
          }
        }
        if (Array.isArray(parsed.instruments)) {
          for (const i of parsed.instruments) {
            await saveExtractedTerm(channel.country, i, 'instrument', channel.channel_id);
            await observeTerminology({ term: String(i), country: channel.country, termType: 'INSTRUMENT', observationType: humanApproved ? 'HUMAN_APPROVED_CHANNEL' : 'ENRICHMENT', channelId: channel.channel_id, humanApproved, communityFingerprint: channel.discord_invite || undefined, evidence: { extractor: 'GEMINI' } });
          }
        }
        if (Array.isArray(parsed.phrases)) {
          for (const p of parsed.phrases) {
            await saveExtractedTerm(channel.country, p, 'phrase', channel.channel_id);
            await observeTerminology({ term: String(p), country: channel.country, termType: 'PHRASE', observationType: 'ENRICHMENT', channelId: channel.channel_id, communityFingerprint: channel.discord_invite || undefined, evidence: { extractor: 'GEMINI' } });
          }
        }
        if (Array.isArray(parsed.formats)) {
          for (const f of parsed.formats) {
            await saveExtractedTerm(channel.country, f, 'format', channel.channel_id);
            await observeTerminology({ term: String(f), country: channel.country, termType: 'FORMAT', observationType: 'ENRICHMENT', channelId: channel.channel_id, communityFingerprint: channel.discord_invite || undefined, evidence: { extractor: 'GEMINI' } });
          }
        }
      }
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

  // Enrich country vocabulary in memory/database with top extracted terms
  const newlyExtracted = await getExtractedVocabulary(channel.country);
  return newlyExtracted;
}

// ==========================================
// 3. MULTI-ARMED BANDIT (UCB1) QUERY SELECTOR
// ==========================================

/**
 * Selects the next search query for a country using Multi-Armed Bandit (UCB1)
 * balancing exploitation (PROVEN) vs exploration (EXPERIMENTAL) with intent rotation.
 */
export async function selectNextQueryForCountry(country: string): Promise<{
  queryRecord: QueryRecord;
  selectionStrategy: 'UCB1_EXPLOITATION' | 'UCB1_EXPLORATION' | 'COLD_START_GENERATION';
  reason: string;
}> {
  const now = new Date();
  const queries = (await getQueriesByCountry(country)).filter(query => {
    const reservedUntil = (query as QueryRecord & { reserved_until?: string | null }).reserved_until;
    const nextEligibleAt = (query as QueryRecord & { next_eligible_at?: string | null }).next_eligible_at;
    return query.collection !== 'REJECTED'
      && (!reservedUntil || new Date(reservedUntil) <= now)
      && (!nextEligibleAt || new Date(nextEligibleAt) <= now);
  });
  const cooldownMinutes = Math.max(1, Number(await getAppSetting('query_intelligence_query_cooldown_minutes', process.env.QUERY_INTELLIGENCE_COOLDOWN_MINUTES || '360')) || 360);
  const maxPrimaryUses = Math.max(1, Number(await getAppSetting('query_intelligence_primary_term_max_uses', process.env.QUERY_INTELLIGENCE_PRIMARY_TERM_MAX_USES || '2')) || 2);
  const explorationRatio = Math.min(0.9, Math.max(0.1, Number(await getAppSetting('query_intelligence_exploration_ratio', process.env.QUERY_INTELLIGENCE_EXPLORATION_RATIO || '0.4')) || 0.4));

  // If no queries exist for country, generate cold-start initial queries
  if (queries.length === 0) {
    const generated = await generateCandidateQueriesForCountry(country, 4, 'COLD_START');
    const selected = generated[0];
    return {
      queryRecord: selected,
      selectionStrategy: 'COLD_START_GENERATION',
      reason: selected.generation_reason || `Cold start query initialization for ${country}`
    };
  }

  // Cooldown is a hard eligibility gate, never merely a score penalty.
  const outsideCooldown = queriesOutsideCooldown(queries, now, cooldownMinutes);
  let eligible = limitRepeatedPrimaryTerms(outsideCooldown, queries, now, cooldownMinutes, maxPrimaryUses);
  eligible = rotateAwayFromMostRecentIntent(eligible, queries);
  if (eligible.length === 0) {
    const generated = await generateCandidateQueriesForCountry(country, 4, 'EXPLORATION');
    const selected = generated[0];
    return {
      queryRecord: selected,
      selectionStrategy: 'UCB1_EXPLORATION',
      reason: `${selected.generation_reason} Existing queries were unavailable due to the ${cooldownMinutes}-minute cooldown or primary-term diversity limit.`
    };
  }

  // Calculate UCB1 score for each query
  const totalExecutionsSum = eligible.reduce((acc, q) => acc + q.times_executed, 0);
  const totalExecutions = Math.max(1, totalExecutionsSum);

  const scoredQueries = eligible.map(q => {
    // Normalized performance score (0 to 1)
    const normPerformance = (q.performance_score || 0) / 100;

    // UCB1 formula: Score + c * sqrt(ln(N) / (n_i + 1))
    const explorationConst = 0.8;
    const ucbTerm = explorationConst * Math.sqrt(Math.log(totalExecutions + 1) / ((q.times_executed || 0) + 1));
    const ucbScore = Math.max(0, normPerformance + ucbTerm);

    return {
      ...q,
      ucb_score: Math.round(ucbScore * 100) / 100
    };
  });

  // Sort by UCB score descending
  scoredQueries.sort((a, b) => (b.ucb_score || 0) - (a.ucb_score || 0));

  // Explicitly configured exploration prevents permanent overfitting to winners.
  const isExploration = Math.random() < explorationRatio;

  let selected: QueryRecord | null = null;
  let strategy: 'UCB1_EXPLOITATION' | 'UCB1_EXPLORATION' | 'COLD_START_GENERATION' = 'UCB1_EXPLOITATION';
  let reason = '';

  if (isExploration) {
    // Pick an EXPERIMENTAL query with highest UCB or generate a new candidate
    const experimental = scoredQueries
      .filter(q => q.collection === 'EXPERIMENTAL')
      .sort((a, b) => a.times_executed - b.times_executed || (b.ucb_score || 0) - (a.ucb_score || 0));
    if (experimental.length > 0) {
      selected = experimental[0];
      strategy = 'UCB1_EXPLORATION';
      reason = `Exploration selected an eligible experimental query outside the ${cooldownMinutes}-minute cooldown: ${selected.generation_reason || selected.query} (UCB ${selected.ucb_score}).`;
    }
  }

  if (!selected) {
    // Default to top overall UCB query (usually PROVEN)
    selected = scoredQueries.find(query => query.collection === 'PROVEN') || scoredQueries[0];
    strategy = selected.collection === 'PROVEN' ? 'UCB1_EXPLOITATION' : 'UCB1_EXPLORATION';
    reason = `${strategy === 'UCB1_EXPLOITATION' ? 'Exploitation retained a historically successful query' : 'Exploration selected the best eligible candidate'} outside the ${cooldownMinutes}-minute cooldown (UCB ${selected.ucb_score}). ${selected.generation_reason || ''}`.trim();
  }

  return { queryRecord: selected, selectionStrategy: strategy, reason };
}

// ==========================================
// 4. CANDIDATE QUERY GENERATOR
// ==========================================

/** Generates auditable, compact candidates led by retrieval atoms and proven terminology. */
export async function generateCandidateQueriesForCountry(
  country: string,
  count = 3,
  mode: 'EXPLORATION' | 'EXPLOITATION' | 'COLD_START' = 'EXPLORATION'
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
    mode
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

// ==========================================
// 5. PERFORMANCE EVALUATOR & PROMOTION/DEMOTION
// ==========================================

/**
 * Evaluates the performance of a search query run and promotes/demotes collections
 */
export async function evaluateQueryPerformance(
  queryRecord: QueryRecord,
  metrics: QueryFunnelMetrics,
  attribution: { retrievalLane?: string; searchOrdering?: string; quotaConsumed?: number } = {}
): Promise<{ performanceScore: number; newCollection: QueryCollection; summary: string }> {
  const performanceScore = metrics.performanceScore;
  const newCollection = selectQueryCollection(queryRecord.collection, queryRecord.times_executed, metrics);

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

  return {
    performanceScore,
    newCollection,
    summary: `Executed with score ${performanceScore}/100 (${metrics.newChannels} new, ${metrics.knownChannels} known, ${metrics.countryRejected} wrong-country, ${metrics.nonTrading} non-trading, ${metrics.uncertain} uncertain, ${metrics.tradingConfirmed} confirmed). Collection: ${newCollection}.`
  };
}
