import { TradingClassificationResult, TradingRelevanceBreakdown } from '../src/types';
import { buildCanonicalEvidenceCorpus, verifyChannelTradingRelevance, VerificationDecision, type RawChannelInput } from './evidenceEngine';
import { resolveClassificationRouting, resolveClassificationRoutingMode } from './classificationRouting/deterministicFirst';
import { evaluateCategoryPrecisionGuard } from './evidenceEngine/categoryPrecisionGuard';

/**
 * Semantic provider outcomes only. A deterministic provider failure must not
 * relabel a semantic attempt as degraded or abstained.
 */
/**
 * Only a semantic verdict that actually served may own the content category.
 * An abstention can retain a relevant label (no citations, low confidence, or
 * unsupported language) but must not disable the video-focus review guard.
 */
export function routingContentCategory(
  summary?: { isTrading?: string; taxonomyLabel?: string },
): string | undefined {
  if (!summary || summary.isTrading === 'UNCERTAIN') return undefined;
  return summary.taxonomyLabel;
}

export function semanticProviderOutcomeFlags(
  providers: Array<{ provider?: string; outcome?: string }>,
): { abstained: boolean; failed: boolean; served: boolean } {
  const semantic = providers.filter(provider => /semantic/.test(String(provider.provider)));
  // Suppressed/unavailable routes never ran. A real outage is measured over
  // attempted routes only, so an unconfigured primary cannot hide a failed
  // fallback or vice versa.
  const attempted = semantic.filter(provider => !['SUPPRESSED_BY_POLICY','NOT_APPLICABLE','UNAVAILABLE_CONFIGURATION'].includes(String(provider.outcome)));
  const outcomes = attempted.map(provider => String(provider.outcome));
  return {
    served: outcomes.includes('EXECUTED_WITH_EVIDENCE'),
    abstained: outcomes.some(outcome => outcome.startsWith('ABSTAINED_')),
    // A fallback success is not a provider failure. Only an all-attempted
    // provider outage is a technical failure.
    failed: outcomes.length > 0 && outcomes.every(outcome => outcome.startsWith('FAILED_')),
  };
}

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

  // The engine builds the canonical corpus on a local copy. Attach the same
  // deterministic corpus to the caller-visible input so the diagnostic ledger
  // and the semantic result cache fingerprint identical evidence; otherwise
  // the cache key covers documents the ledger's checksum omits.
  input.evidence_corpus = buildCanonicalEvidenceCorpus(input);
  const decision: VerificationDecision = await verifyChannelTradingRelevance(input);
  const semantic = semanticProviderOutcomeFlags(decision.evidenceCollection.providers);
  // A precision downgrade is only meaningful on a relevant result produced by
  // a semantic provider. A provider outage must defer, never be relabelled.
  const precision = decision.status !== 'NON_TRADING' && semantic.served
    ? await evaluateCategoryPrecisionGuard(input, decision.geminiSemanticSummary?.taxonomyLabel)
    : { status: 'KEEP' as const, result: null };
  if (precision.status === 'DOWNGRADE' && precision.result) {
    const guard = precision.result;
    // A precision guard may only downgrade a first-pass relevant category.
    // It never upgrades, and the evidence safeguards are untouched.
    decision.status = 'NON_TRADING';
    decision.confidenceScore = Math.min(22, decision.confidenceScore);
    decision.geminiSemanticSummary = {
      ...(decision.geminiSemanticSummary || { concepts: [], instruments: [], reason: '', modelUsed: undefined }),
      isTrading: 'NO',
      taxonomyLabel: guard.category,
      reason: `[${guard.category}] Precision guard: ${guard.reasonCodes.join(', ')}`,
    };
    decision.decisionPolicy = {
      ...(decision.decisionPolicy || { version: 'precision-guard-v1', tradingProbability: 0, nonTradingProbability: 0, coverageConfidence: 0, reasonCodes: [] }),
      reasonCodes: [
        ...(decision.decisionPolicy?.reasonCodes || []),
        'CONTENT_CATEGORY_PRECISION_GUARD',
        ...guard.reasonCodes,
      ],
    };
  } else if (precision.status === 'UNAVAILABLE') {
    // A provider outage must never silently confirm a first-pass relevant
    // result that the adjudicator could not clear. Defer/retry instead of
    // creating human review.
    decision.status = 'UNCERTAIN';
    decision.decisionPolicy = {
      ...(decision.decisionPolicy || { version: 'precision-guard-v1', tradingProbability: 0, nonTradingProbability: 0, coverageConfidence: 0, reasonCodes: [] }),
      reasonCodes: [
        ...(decision.decisionPolicy?.reasonCodes || []),
        'PRECISION_ADJUDICATOR_UNAVAILABLE_DEFERRED',
      ],
    };
  }
  const corroboration = decision.stagedClassification?.stages.find(stage => stage.stage === 'CORROBORATION');
  const lifecycleStage = decision.stagedClassification?.stages.find(stage => stage.stage === 'LIFECYCLE');
  const routingMode = resolveClassificationRoutingMode();
  const videoDocuments = input.videos?.length
    ? input.videos
    : (input.video_titles || []).map((title, index) => ({ title, description: input.video_descriptions?.[index] || '' }));
  // Keep one document per video. Collapsing identical text would hide two
  // distinct uploads from the mismatch guard.
  const videoTexts = videoDocuments
    .map(video => [video.title, video.description].filter(Boolean).join('\n').trim())
    .filter(Boolean);
  const routing = resolveClassificationRouting(decision, {
    independentEvidence: corroboration?.disposition === 'PASS',
    videoTexts,
    mode: routingMode,
    lifecycleAction: decision.stagedClassification?.lifecycleAction,
    acquisitionEnrich: lifecycleStage?.reasonCodes.includes('ACQUISITION_ENRICH') ?? false,
    acquisitionReason: lifecycleStage?.reasonCodes.find(code =>
      code === 'COMPOSITION_EVIDENCE_REQUIRED' || code === 'THIN_RETRIEVAL_INPUT_REQUIRES_HYDRATION'),
    contentCategory: routingContentCategory(decision.geminiSemanticSummary),
  });
  if (routingMode === 'ACTIVE') decision.deterministicRouting = routing;

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

  // An abstention is not semantic service. Use the routing result so a
  // deterministic fast-track is not misreported as AI-reviewed and a
  // semantic abstention is not presented as a semantic verdict.
  const legacyReporting = routingMode === 'LEGACY';
  // Only semantic provider failures/abstentions may affect semantic labels;
  // a deterministic provider failure must not relabel a semantic attempt.
  const { abstained: semanticAbstained, failed: semanticFailed } =
    semanticProviderOutcomeFlags(decision.evidenceCollection.providers || []);
  const semanticServed = legacyReporting
    ? (!!decision.geminiSemanticSummary || String(decision.classificationMethod || '').startsWith('SEMANTIC_'))
    : routing.semanticUsed;
  const classificationMethod: TradingRelevanceBreakdown['classification_method'] = legacyReporting
    ? (semanticServed ? 'AI_SEMANTIC_CLASSIFIER'
      : decision.classificationMethod === 'DETERMINISTIC_EVIDENCE' ? 'DETERMINISTIC_EVIDENCE'
        : decision.classificationMethod === 'DEGRADED_HEURISTIC' ? 'DEGRADED_HEURISTIC'
          : 'HEURISTIC_ONLY')
    : routing.route === 'DETERMINISTIC_TRADING' || routing.route === 'DETERMINISTIC_NON_TRADING'
      ? 'DETERMINISTIC_EVIDENCE'
      : semanticServed
        ? 'AI_SEMANTIC_CLASSIFIER'
        : routing.semanticAttempted
          ? semanticAbstained ? 'SEMANTIC_ABSTAINED' : semanticFailed ? 'DEGRADED_HEURISTIC' : 'SEMANTIC_NO_MATCH'
          : decision.classificationMethod === 'DEGRADED_HEURISTIC'
            ? 'DEGRADED_HEURISTIC'
            : 'HEURISTIC_ONLY';
  const noEvidence = decision.evidenceCount !== undefined
    ? decision.evidenceCount === 0
    : [...decision.positiveEvidence, ...decision.negativeEvidence].every(item => item.category === 'SEMANTIC_ABSTENTION');
  const breakdown: TradingRelevanceBreakdown = {
    stage_a_score: Math.round(decision.totalPositiveWeight),
    consistency_ratio: decision.multiVideoConsistencyRatio,
    ai_reviewed: semanticServed,
    // Cost accounting needs attempted AI calls (including abstentions), while
    // `ai_reviewed`/`semantic_used` report whether semantic evidence served.
    semantic_attempted: legacyReporting ? semanticServed : routing.semanticAttempted,
    fast_heuristic_status: decision.status === 'TRADING_CONFIRMED' ? 'FAST_ACCEPT' : decision.status === 'NON_TRADING' ? 'FAST_REJECT' : 'UNCERTAIN',
    classification_method: classificationMethod,
    // Every non-empty assessment is scored by the unified decision policy,
    // which returns a calibrated probability regardless of semantic serving.
    confidence_basis: noEvidence ? 'NEUTRAL_PRIOR' : 'CALIBRATED',
    ai_model: decision.geminiSemanticSummary?.modelUsed || decision.versions.geminiModelVersion,
    content_category: decision.geminiSemanticSummary?.taxonomyLabel,
    content_category_confidence: decision.geminiSemanticSummary?.calibratedConfidence,
    ai_prompt_payload: decision.geminiSemanticSummary ? JSON.stringify(decision.geminiSemanticSummary) : undefined,
    ai_raw_response: decision.geminiSemanticSummary ? decision.geminiSemanticSummary.reason : undefined,
    ...(legacyReporting ? {} : {
      classification_route: routing.route,
      deterministic_fast_track: routing.fastTrack,
      semantic_used: routing.semanticUsed,
      human_review_candidate: routing.humanReview,
      routing_fallback_reason: routing.fallbackReason,
      routing_policy_version: routing.version,
    }),
    reasoning: [
      ...reasoningLogs,
      ...(legacyReporting ? [] : [`Deterministic-first route: ${routing.route} | fastTrack=${routing.fastTrack} | semanticUsed=${routing.semanticUsed} | fallback=${routing.fallbackReason || 'none'} | ${routing.reasonCodes.join(', ')}`]),
    ]
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
