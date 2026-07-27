import { GoogleGenAI } from '@google/genai';
import { ChannelRecord, CountryVocabulary, QualityScoreBreakdown, QueryRecord, QueryCollection, QueryIntent, ExtractedTermRecord } from '../src/types';
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
  upsertChannel
} from './db';

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
 * Calculates a non-engagement-dominant Creator Quality Score (0 - 100)
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

  // 2. Freshness & Activity (Max 25)
  let freshnessScore = 20; // Default active assumption
  if (videoTitles.length > 0) {
    freshnessScore = 25;
    reasons.push(`Active content stream with ${videoTitles.length} recent video titles analyzed`);
  } else {
    reasons.push('Standard activity level');
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
  description: string = ''
): Promise<ExtractedTermRecord[]> {
  const extracted: ExtractedTermRecord[] = [];
  const ai = getAIClient();

  if (!channel.country || channel.country === 'Unknown') return [];

  // 1. Rule-based extraction of instruments & terminology
  const text = `${channel.channel_name} ${description} ${videoTitles.join(' ')}`;
  const textLower = text.toLowerCase();

  // Known instruments & phrases pattern matching
  const potentialInstruments = ['NQ', 'ES', 'DAX', 'FDAX', 'CAC 40', 'IBEX 35', 'FTSE 100', 'AEX', 'BTC', 'ETH', 'EURUSD', 'GBPUSD', 'Gold', 'WTI Crude', 'S&P 500', 'Nasdaq'];
  for (const inst of potentialInstruments) {
    if (textLower.includes(inst.toLowerCase())) {
      await saveExtractedTerm(channel.country, inst, 'instrument', channel.channel_id);
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

      const response = await callGeminiSafe(() => ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: prompt
      }));

      const resText = response.text || '';
      const jsonMatch = resText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.terminology)) {
          for (const t of parsed.terminology) {
            await saveExtractedTerm(channel.country, t, 'terminology', channel.channel_id);
          }
        }
        if (Array.isArray(parsed.instruments)) {
          for (const i of parsed.instruments) {
            await saveExtractedTerm(channel.country, i, 'instrument', channel.channel_id);
          }
        }
        if (Array.isArray(parsed.phrases)) {
          for (const p of parsed.phrases) {
            await saveExtractedTerm(channel.country, p, 'phrase', channel.channel_id);
          }
        }
        if (Array.isArray(parsed.formats)) {
          for (const f of parsed.formats) {
            await saveExtractedTerm(channel.country, f, 'format', channel.channel_id);
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
  const queries = await getQueriesByCountry(country);
  const now = new Date();

  // If no queries exist for country, generate cold-start initial queries
  if (queries.length === 0) {
    const generated = await generateCandidateQueriesForCountry(country, 4);
    const selected = generated[0];
    return {
      queryRecord: selected,
      selectionStrategy: 'COLD_START_GENERATION',
      reason: `Cold start query initialization for ${country}`
    };
  }

  // Calculate UCB1 score for each query
  const totalExecutionsSum = queries.reduce((acc, q) => acc + q.times_executed, 0);
  const totalExecutions = Math.max(1, totalExecutionsSum);

  const scoredQueries = queries.map(q => {
    // Cooldown check: penalize queries executed in the last 2 hours
    let cooldownPenalty = 0;
    if (q.last_executed) {
      const elapsedMinutes = (now.getTime() - new Date(q.last_executed).getTime()) / (1000 * 60);
      if (elapsedMinutes < 120) {
        cooldownPenalty = 0.5; // reduces UCB score significantly
      }
    }

    // Normalized performance score (0 to 1)
    const normPerformance = (q.performance_score || 0) / 100;

    // UCB1 formula: Score + c * sqrt(ln(N) / (n_i + 1))
    const explorationConst = 0.8;
    const ucbTerm = explorationConst * Math.sqrt(Math.log(totalExecutions + 1) / ((q.times_executed || 0) + 1));
    const ucbScore = Math.max(0, normPerformance + ucbTerm - cooldownPenalty);

    return {
      ...q,
      ucb_score: Math.round(ucbScore * 100) / 100
    };
  });

  // Sort by UCB score descending
  scoredQueries.sort((a, b) => (b.ucb_score || 0) - (a.ucb_score || 0));

  // Determine whether to Exploit (60% chance) or Explore (40% chance)
  const isExploration = Math.random() < 0.4;

  let selected: QueryRecord | null = null;
  let strategy: 'UCB1_EXPLOITATION' | 'UCB1_EXPLORATION' | 'COLD_START_GENERATION' = 'UCB1_EXPLOITATION';
  let reason = '';

  if (isExploration) {
    // Pick an EXPERIMENTAL query with highest UCB or generate a new candidate
    const experimental = scoredQueries.filter(q => q.collection === 'EXPERIMENTAL');
    if (experimental.length > 0) {
      selected = experimental[0];
      strategy = 'UCB1_EXPLORATION';
      reason = `Selected top experimental query "${selected.query}" (UCB Score: ${selected.ucb_score})`;
    }
  }

  if (!selected) {
    // Default to top overall UCB query (usually PROVEN)
    selected = scoredQueries[0];
    strategy = selected.collection === 'PROVEN' ? 'UCB1_EXPLOITATION' : 'UCB1_EXPLORATION';
    reason = `Selected top performing ${selected.collection} query "${selected.query}" (UCB Score: ${selected.ucb_score})`;
  }

  return { queryRecord: selected, selectionStrategy: strategy, reason };
}

// ==========================================
// 4. CANDIDATE QUERY GENERATOR
// ==========================================

const INTENTS: QueryIntent[] = [
  'market_analysis',
  'premarket_prep',
  'live_trading',
  'educational',
  'weekly_reviews',
  'trading_journals',
  'session_analysis',
  'strategy_breakdowns',
  'prop_firm'
];

/**
 * Generates brand new candidate queries combining knowledge base + learned vocabulary
 */
export async function generateCandidateQueriesForCountry(
  country: string,
  count = 3
): Promise<QueryRecord[]> {
  const vocabs = await getCountryVocabularies();
  const countryVocab = vocabs.find(v => v.country.toLowerCase() === country.toLowerCase());
  const extractedTerms = await getExtractedVocabulary(country);

  const nativeTerms = countryVocab?.native_trading_terminology || ['trading analysis', 'market structure'];
  const instruments = countryVocab?.popular_instruments || ['EURUSD', 'S&P 500'];
  const formatNames = countryVocab?.common_content_format_names || ['Market breakdown', 'Trading journal'];
  const learnedTerms = extractedTerms.map(t => t.term);

  const combinedTerms = Array.from(new Set([...nativeTerms, ...learnedTerms]));

  const ai = getAIClient();
  const newQueries: QueryRecord[] = [];

  if (ai) {
    try {
      const prompt = `You are the Search Query Intelligence Engine for a YouTube trading creator discovery platform.
Target Country: "${country}"
Primary Languages: ${countryVocab?.languages?.join(', ') || 'English'}
Known Financial Instruments: ${instruments.join(', ')}
Native Trading Terminology & Learned Vocabulary: ${combinedTerms.join(', ')}
Content Formats: ${formatNames.join(', ')}

Generate ${count} distinct, highly specific search queries that authentic educational trading creators in ${country} would use in their YouTube video titles or channel descriptions.
Requirements:
1. NEVER output generic or spammy words like "get rich", "best signals", "crypto 1000x".
2. Prefer queries focusing on active market analysis, session breakdowns, futures/forex/stock trading, and trading journals.
3. Incorporate local country trading terms in native language when applicable.
4. Output JSON array of objects:
[
  {
    "query": "string",
    "intent": "market_analysis | premarket_prep | live_trading | educational | weekly_reviews | trading_journals | session_analysis | strategy_breakdowns | prop_firm"
  }
]`;

      const response = await callGeminiSafe(() => ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: prompt
      }));

      const resText = response.text || '';
      const jsonMatch = resText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed: Array<{ query: string; intent: string }> = JSON.parse(jsonMatch[0]);
        for (const item of parsed) {
          if (item.query && item.query.trim().length > 3) {
            const record = await upsertQueryRecord({
              query: item.query.trim(),
              country,
              collection: 'EXPERIMENTAL',
              intent: item.intent || 'market_analysis'
            });
            newQueries.push(record);
          }
        }
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      const isQuota = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota');
      const is503 = msg.includes('503') || msg.includes('high demand');
      if (isQuota) {
        console.warn(`[Query Generation] Gemini API quota limit reached (429) for ${country}. Fallback queries will be generated.`);
      } else if (is503) {
        console.warn(`[Query Generation] Gemini API temporarily busy (503) for ${country}. Fallback queries will be generated.`);
      } else {
        console.warn(`[Query Generation] Notice for ${country}:`, msg.length > 150 ? msg.slice(0, 150) + '...' : msg);
      }
    }
  }

  // Fallback programmatic query construction if AI fails or returns fewer than requested
  if (newQueries.length < count) {
    for (let i = newQueries.length; i < count; i++) {
      const term = combinedTerms[i % combinedTerms.length] || 'market structure';
      const inst = instruments[i % instruments.length] || '';
      const intent = INTENTS[i % INTENTS.length];

      const queryText = `${inst} ${term}`.trim();
      const record = await upsertQueryRecord({
        query: queryText,
        country,
        collection: 'EXPERIMENTAL',
        intent
      });
      newQueries.push(record);
    }
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
  discoveredChannels: ChannelRecord[],
  uniqueNewCount: number
): Promise<{ performanceScore: number; newCollection: QueryCollection; summary: string }> {
  const totalDiscovered = discoveredChannels.length;

  if (totalDiscovered === 0) {
    const perfScore = 0;
    const newCollection = (queryRecord.times_executed >= 2) ? 'REJECTED' as QueryCollection : queryRecord.collection;
    await updateQueryExecutionStats(queryRecord.id, {
      totalChannelsFound: 0,
      uniqueChannelsFound: 0,
      qualityChannelsFound: 0,
      communityChannelsFound: 0,
      avgQualityScore: 0,
      performanceScore: perfScore,
      newCollection
    });
    return {
      performanceScore: perfScore,
      newCollection,
      summary: `Query returned 0 channels. Demoted to ${newCollection}.`
    };
  }

  // Calculate quality, trading relevance, and community yields
  const tradingConfirmedChannels = discoveredChannels.filter(c => c.trading_status === 'TRADING_CONFIRMED');
  const qualityChannels = discoveredChannels.filter(c => (c.quality_score || 0) >= 55);
  const communityChannels = discoveredChannels.filter(c => c.discord_status === 'ACTIVE' || c.discord_status === 'ACTIVE_LOW_VOLUME');

  const tradingYieldRatio = tradingConfirmedChannels.length / totalDiscovered;
  const qualityYieldRatio = qualityChannels.length / totalDiscovered;
  const communityYieldRatio = communityChannels.length / totalDiscovered;
  const uniqueRatio = uniqueNewCount / Math.max(1, totalDiscovered);

  const totalQualitySum = discoveredChannels.reduce((sum, c) => sum + (c.quality_score || 0), 0);
  const avgQualityScore = Math.round(totalQualitySum / totalDiscovered);

  // Performance formula (0 - 100) incorporating Trading Relevance Yield
  const performanceScore = Math.round(
    (0.35 * (tradingYieldRatio * 100)) +
    (0.25 * (uniqueRatio * 100)) +
    (0.25 * avgQualityScore) +
    (0.15 * (communityYieldRatio * 100))
  );

  // Determine Collection Promotion / Demotion
  let newCollection = queryRecord.collection;
  const totalRuns = queryRecord.times_executed + 1;

  if (performanceScore >= 60 && totalRuns >= 1) {
    newCollection = 'PROVEN';
  } else if (performanceScore < 25 && totalRuns >= 2) {
    newCollection = 'REJECTED';
  } else {
    newCollection = 'EXPERIMENTAL';
  }

  await updateQueryExecutionStats(queryRecord.id, {
    totalChannelsFound: totalDiscovered,
    uniqueChannelsFound: uniqueNewCount,
    qualityChannelsFound: qualityChannels.length,
    communityChannelsFound: communityChannels.length,
    avgQualityScore,
    performanceScore,
    newCollection
  });

  return {
    performanceScore,
    newCollection,
    summary: `Executed with score ${performanceScore}/100 (${uniqueNewCount} unique, ${qualityChannels.length} quality, ${communityChannels.length} communities). Collection: ${newCollection}.`
  };
}
