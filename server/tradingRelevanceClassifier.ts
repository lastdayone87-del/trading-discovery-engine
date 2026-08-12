import { TradingClassificationResult, TradingRelevanceBreakdown } from '../src/types';
import { verifyChannelTradingRelevance, VerificationDecision, type RawChannelInput } from './evidenceEngine';

/**
 * Main Entry Point: Classifies a YouTube Channel's Trading Relevance
 * Architecture: Evidence-Based Trading Verification Engine
 * 1. Independent Providers (Channel, Video, External, Country Knowledge, Gemini OSINT, Discord)
 * 2. Deterministic Configurable Scoring Strategy
 * 3. Complete Versioning & Explainability Audit Payload
 */
export async function classifyTradingRelevance(
  channelName: string,
  description: string,
  videoTitles: string[] = [],
  videoDescriptions: string = '',
  country: string = 'UNKNOWN',
  externalLinks: string[] = [],
  discordInvite?: string | null
): Promise<TradingClassificationResult> {
  return (await classifyTradingRelevanceDetailed(channelName, description, videoTitles, videoDescriptions, country, externalLinks, discordInvite)).result;
}

/** Exposes the immutable evidence decision to the shadow path without rerunning providers. */
export async function classifyTradingRelevanceDetailed(
  channelName: string | RawChannelInput,
  description: string = '',
  videoTitles: string[] = [],
  videoDescriptions: string = '',
  country: string = 'UNKNOWN',
  externalLinks: string[] = [],
  discordInvite?: string | null
): Promise<{result: TradingClassificationResult; decision: VerificationDecision; input: RawChannelInput}> {
  const input: RawChannelInput = typeof channelName === 'object' ? normalizeFieldAwareInput(channelName) : {
    channel_name: channelName,
    description,
    video_titles: videoTitles,
    video_descriptions: videoDescriptions ? [videoDescriptions] : [],
    country,
    external_links: externalLinks,
    discord_invite: discordInvite
  };

  const decision: VerificationDecision = await verifyChannelTradingRelevance(input);

  // Map to legacy breakdown format while adding rich evidence audit details
  const reasoningLogs: string[] = [
    `Evidence Engine Version: ${decision.versions.evidenceEngineVersion} | Scoring Engine: ${decision.versions.scoringEngineVersion}`,
    `Country Context Used: ${decision.countryContextUsed.country} (${decision.countryContextUsed.language})`,
    `Evidence Sufficiency: ${decision.evidenceCollection.sufficiency} | Sparse Metadata: ${decision.evidenceCollection.sparseMetadata} | Degraded Providers: ${decision.evidenceCollection.degraded}`,
    `Provider Execution: ${decision.evidenceCollection.providers.map(provider => `${provider.provider}=${provider.outcome}[${provider.reasonCodes.join('|')}](${provider.durationMs||0}ms)`).join(', ')}`,
    ...(decision.stagedClassification?.stages.map(stage => `Classification Stage ${stage.stage}: ${stage.disposition} (${stage.reasonCodes.join(', ')}) | Fields: ${stage.fields.map(field => field.field).join(', ') || 'none'}`) || []),
    decision.mathematicalJustification
  ];

  for (const pos of decision.positiveEvidence) {
    const prov = pos.provenance;
    const provSuffix = prov
      ? ` | Provider: ${prov.provider} | Source: ${prov.sourceRef} | Term: "${prov.matchedTerm}"`
      : '';
    reasoningLogs.push(`[+EVIDENCE] (${pos.source} / ${pos.reliability}): ${pos.fact}${provSuffix}`);
  }

  for (const neg of decision.negativeEvidence) {
    const prov = neg.provenance;
    const provSuffix = prov
      ? ` | Provider: ${prov.provider} | Source: ${prov.sourceRef} | Term: "${prov.matchedTerm}"`
      : '';
    reasoningLogs.push(`[-EVIDENCE] (${neg.source} / ${neg.reliability}): ${neg.fact}${provSuffix}`);
  }

  const breakdown: TradingRelevanceBreakdown = {
    stage_a_score: Math.round(decision.totalPositiveWeight),
    consistency_ratio: decision.multiVideoConsistencyRatio,
    ai_reviewed: !!decision.geminiSemanticSummary,
    fast_heuristic_status: decision.status === 'TRADING_CONFIRMED' ? 'FAST_ACCEPT' : decision.status === 'NON_TRADING' ? 'FAST_REJECT' : 'UNCERTAIN',
    classification_method: 'AI_SEMANTIC_CLASSIFIER',
    ai_model: decision.versions.geminiModelVersion,
    ai_prompt_payload: decision.geminiSemanticSummary ? JSON.stringify(decision.geminiSemanticSummary) : undefined,
    ai_raw_response: decision.geminiSemanticSummary ? decision.geminiSemanticSummary.reason : undefined,
    reasoning: reasoningLogs
  };

  const result: TradingClassificationResult = {
    status: decision.status,
    confidenceScore: decision.confidenceScore,
    category: decision.category,
    breakdown
  };
  return {result, decision, input};
}

/**
 * Preserves the complete field-aware schema at the production boundary while
 * enforcing evidence independence. A search-match document is retrieval
 * provenance, not an independent sample of the creator's content. Until a
 * channel has completed enrichment, the titles/descriptions copied from that
 * search result must not be promoted into the video-evidence providers.
 */
export function normalizeFieldAwareInput(value: RawChannelInput): RawChannelInput {
  const retrievalOnly = !!value.search_match_context && (value.enrichment_stage || 0) === 0;
  const videos = retrievalOnly
    ? []
    : value.videos?.map(video=>({...video})) || (value.video_titles||[]).map((title,index)=>({title,description:value.video_descriptions?.[index]}));
  return {
    ...value,
    channel_name:value.channel_name.normalize('NFKC').trim(),
    description:value.description || '',
    videos,
    video_titles:videos.map(video=>video.title),
    video_descriptions:videos.map(video=>video.description || ''),
    external_links:value.external_links || value.external_link_details?.map(link=>link.url) || []
  };
}
