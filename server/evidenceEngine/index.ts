import { EvidenceCollectionReport, EvidenceItem, EvidenceProvider, LayeredKnowledgeContext, ProviderExecutionReport, RawChannelInput, VerificationDecision, ScoringEngineConfig } from './types';
import { getLayeredKnowledgeContext, LANGUAGE_KNOWLEDGE_PACKS } from './knowledgePacks';
import { ChannelMetadataProvider } from './providers/ChannelMetadataProvider';
import { VideoMetadataProvider } from './providers/VideoMetadataProvider';
import { ExternalLinkProvider } from './providers/ExternalLinkProvider';
import { CountryKnowledgeProvider } from './providers/CountryKnowledgeProvider';
import { GeminiSemanticProvider } from './providers/GeminiSemanticProvider';
import { GroqSemanticProvider, shouldUseGroqSemantic } from './providers/GroqSemanticProvider';
import { GeminiFreeSemanticProvider, shouldUseGeminiFreeSemantic } from './providers/GeminiFreeSemanticProvider';
import { DiscordProvider } from './providers/DiscordProvider';
import { MultilingualContextProvider } from './providers/MultilingualContextProvider';
import { ConfigurableWeightedStrategy } from './scoringEngine';
import { evaluateClassificationStages } from './stagedClassification';
import { buildCanonicalEvidenceCorpus, validateEvidenceProvenance } from './canonicalEvidencePlane';
import { contentLanguagePacks } from './multilingualTerminology';

function safeProviderFailureReasonCodes(err: any, timeout: boolean): string[] {
  const errorClass = String(err?.errorClass || '');
  const primary = timeout || errorClass === 'TIMEOUT' ? 'PROVIDER_TIMEOUT'
    : errorClass === 'RATE_LIMIT' ? 'PROVIDER_RATE_LIMIT'
    : errorClass === 'PERMANENT_INPUT' ? 'PROVIDER_PERMANENT_INPUT'
    : errorClass === 'CANCELLED' ? 'PROVIDER_CANCELLED'
    : errorClass === 'CREDENTIALS_EXHAUSTED' ? 'PROVIDER_CREDENTIALS_EXHAUSTED'
    : errorClass === 'TRANSIENT' ? 'PROVIDER_TRANSIENT_FAILURE'
    : 'PROVIDER_EXECUTION_FAILED';
  const providerReasons = Array.isArray(err?.providerReasons)
    ? err.providerReasons.map(String).filter((value: string) => /^[A-Z0-9_.:-]{1,80}$/.test(value)).slice(0, 6)
    : [];
  return [primary, ...providerReasons.filter((value: string) => value !== primary)];
}

const SEMANTIC_PROVIDER_NAMES = ['gemini_semantic', 'groq_semantic', 'gemini_free_semantic'] as const;
type SemanticProviderName = typeof SEMANTIC_PROVIDER_NAMES[number];

function isSemanticProviderName(name: string): name is SemanticProviderName {
  return (SEMANTIC_PROVIDER_NAMES as readonly string[]).includes(name);
}

/**
 * Ordered semantic provider chain for one evaluation. The configured primary
 * (current selection semantics, unchanged) runs first; when it is
 * unconfigured or fails, the remaining keyed providers are tried in a fixed
 * resilience order (Groq, then free-tier Gemini) so a single provider outage
 * cannot stall classification. An explicit SEMANTIC_PROVIDER_FORCE_GEMINI
 * pins Gemini-only behavior and disables fallback. Pure function of env for
 * testability; key presence is checked per provider at execution.
 */
export function resolveSemanticProviderChain(
  primaryName: string,
  env: NodeJS.ProcessEnv = process.env
): SemanticProviderName[] {
  const chain: SemanticProviderName[] = isSemanticProviderName(primaryName) ? [primaryName] : [];
  if (env.SEMANTIC_PROVIDER_FORCE_GEMINI === 'true') return chain;
  const probe = (name: SemanticProviderName, selectorEnv: NodeJS.ProcessEnv): boolean => {
    if (chain.includes(name)) return false;
    if (name === 'groq_semantic') return shouldUseGroqSemantic(selectorEnv);
    if (name === 'gemini_free_semantic') return shouldUseGeminiFreeSemantic(selectorEnv);
    return false;
  };
  if (probe('groq_semantic', { ...env, SEMANTIC_PROVIDER: 'groq' })) chain.push('groq_semantic');
  if (probe('gemini_free_semantic', { ...env, SEMANTIC_PROVIDER: 'gemini-free' })) chain.push('gemini_free_semantic');
  return chain;
}

type SemanticChainResult = {
  items: EvidenceItem[];
  reports: ProviderExecutionReport[];
};

/**
 * Execute an ordered semantic chain. Stops at the first provider that
 * returns a verdict — including abstention, which is a valid model verdict,
 * never a reason to shop for a second opinion. Unconfigured providers are
 * skipped silently; failed providers are recorded and the next keyed
 * provider is tried. Never throws: total provider outage degrades to empty
 * evidence with FAILED reports, exactly as a single-provider failure does.
 */
export async function executeSemanticChain(
  candidates: EvidenceProvider[],
  input: RawChannelInput,
  knowledgeContext: LayeredKnowledgeContext
): Promise<SemanticChainResult> {
  const items: EvidenceItem[] = [];
  const reports: SemanticChainResult['reports'] = [];
  let priorFailed = false;
  for (const provider of candidates) {
    const started = Date.now();
    const declared = provider.availability?.(input) || { availability: 'AVAILABLE' as const };
    if (declared.availability === 'NOT_APPLICABLE') {
      reports.push({ provider: provider.name, availability: 'NOT_APPLICABLE', evidenceCount: 0,
        outcome: 'NOT_APPLICABLE', reasonCodes: ['PROVIDER_INPUT_NOT_APPLICABLE'], reason: (declared as { reason?: string }).reason, durationMs: Date.now() - started });
      return { items, reports };
    }
    if (declared.availability !== 'AVAILABLE') {
      reports.push({ provider: provider.name, availability: 'UNAVAILABLE', evidenceCount: 0,
        outcome: 'UNAVAILABLE_CONFIGURATION', reasonCodes: ['PROVIDER_CONFIGURATION_UNAVAILABLE'], reason: (declared as { reason?: string }).reason, durationMs: Date.now() - started });
      continue;
    }
    try {
      const collected = await provider.collectEvidence(input, knowledgeContext);
      const abstention = collected.find(item => item.category === 'SEMANTIC_ABSTENTION');
      const semanticReasons = abstention?.provenance?.semantic?.reasonCodes || [];
      const unsupported = semanticReasons.some(code => /UNSUPPORTED_LANGUAGE|LANGUAGE.*UNSUPPORTED/.test(code));
      const extraCodes = priorFailed ? ['SEMANTIC_FALLBACK_SUCCEEDED'] : [];
      reports.push({ provider: provider.name, availability: 'AVAILABLE', evidenceCount: collected.filter(item => item.rawMatches.length > 0).length,
        outcome: abstention ? (unsupported ? 'ABSTAINED_UNSUPPORTED_LANGUAGE' : 'ABSTAINED_LOW_CONFIDENCE') : collected.length ? 'EXECUTED_WITH_EVIDENCE' : 'EXECUTED_NO_MATCH',
        reasonCodes: [...(abstention ? semanticReasons : [collected.length ? 'PROVIDER_EVIDENCE_EMITTED' : 'PROVIDER_NO_GOVERNED_MATCH']), ...extraCodes], durationMs: Date.now() - started });
      return { items: collected, reports };
    } catch (err: any) {
      console.warn(`[EvidenceEngine] Semantic provider ${provider.name} error:`, err?.message || err);
      const timeout = err?.errorClass === 'TIMEOUT' || /timeout|timed out|abort/i.test(String(err?.message || err));
      // Preserve the failed quota-organization (when the provider error
      // carries one) so retry scheduling can align with that account's
      // cooldown. Omitted when absent to keep report shapes stable.
      const failedOrg = [ (err as { groqOrg?: unknown })?.groqOrg, (err as { geminiOrg?: unknown })?.geminiOrg ]
        .map(value => String(value || '').trim()).find(Boolean);
      reports.push({ provider: provider.name, availability: 'FAILED', evidenceCount: 0,
        outcome: timeout ? 'FAILED_TIMEOUT' : 'FAILED_PROVIDER',
        reasonCodes: safeProviderFailureReasonCodes(err, timeout),
        reason: `Provider failure (${String(err?.errorClass || 'UNKNOWN')}).`, durationMs: Date.now() - started,
        ...(failedOrg ? { orgId: failedOrg } : {}) });
      priorFailed = true;
    }
  }
  return { items, reports };
}

export class EvidenceBasedTradingEngine {
  private providers: EvidenceProvider[];
  private decisionStrategy: ConfigurableWeightedStrategy;

  constructor(customProviders?: EvidenceProvider[], customConfig?: Partial<ScoringEngineConfig>) {
    this.providers = customProviders || [
      new ChannelMetadataProvider(),
      new VideoMetadataProvider(),
      new ExternalLinkProvider(),
      new CountryKnowledgeProvider(),
      new MultilingualContextProvider(),
      new GeminiSemanticProvider(),
      new DiscordProvider()
    ];
    this.decisionStrategy = new ConfigurableWeightedStrategy(customConfig);
  }

  public async evaluateChannel(input: RawChannelInput): Promise<VerificationDecision> {
    // Accept the field-aware schema while retaining the legacy parallel arrays at
    // the provider boundary during the migration.
    input = {
      ...input,
      video_titles: input.video_titles?.length ? input.video_titles : input.videos?.map(video => video.title),
      video_descriptions: input.video_descriptions?.length ? input.video_descriptions : input.videos?.map(video => video.description || ''),
      external_links: input.external_links?.length ? input.external_links : input.external_link_details?.map(link => link.url)
    };
    input.evidence_corpus=buildCanonicalEvidenceCorpus(input);
    const country = input.country || 'UNKNOWN';
    const knowledgeContext = getLayeredKnowledgeContext(country);
    const routedCodes=contentLanguagePacks(input,knowledgeContext).map(pack=>pack.languageCode);
    knowledgeContext.languageKnowledgePacks=[...new Map([...(knowledgeContext.languageKnowledgePacks||[]),...routedCodes.map(code=>LANGUAGE_KNOWLEDGE_PACKS[code]).filter(Boolean)].map(pack=>[pack.languageCode,pack])).values()];

    // Collect evidence from all independent providers in parallel. Semantic
    // routing is resolved per evaluation (not at construction) so
    // SEMANTIC_PROVIDER / SEMANTIC_PROVIDER_FORCE_GEMINI take effect without
    // a restart; default (unset) keeps Gemini exactly as before.
    // SEMANTIC_PROVIDER names a single provider, so the gemini-free and groq
    // selectors are mutually exclusive by construction; neither is a fallback
    // for the other.
    const providers = shouldUseGeminiFreeSemantic()
      ? this.providers.map(provider => provider.name === 'gemini_semantic' ? new GeminiFreeSemanticProvider() : provider)
      : shouldUseGroqSemantic()
      ? this.providers.map(provider => provider.name === 'gemini_semantic' ? new GroqSemanticProvider() : provider)
      : this.providers;
    // Semantic providers run as an ordered resilience chain (configured
    // primary, then keyed fallbacks) rather than a single slot: one provider
    // outage must not stall classification. Deterministic providers keep the
    // existing parallel fan-out, untouched. SEMANTIC_PROVIDER_FORCE_GEMINI is
    // an operational safety switch: it pins Gemini-only execution, so a
    // custom Groq/free-tier primary is replaced (never executed) and no
    // fallback chain is built.
    const forceGeminiOnly = process.env.SEMANTIC_PROVIDER_FORCE_GEMINI === 'true';
    const semanticPrimary = forceGeminiOnly
      ? (providers.find(provider => provider.name === 'gemini_semantic') || new GeminiSemanticProvider())
      : providers.find(provider => isSemanticProviderName(provider.name));
    const deterministicProviders = providers.filter(provider => !isSemanticProviderName(provider.name));
    const semanticChain: EvidenceProvider[] = semanticPrimary
      ? [semanticPrimary, ...resolveSemanticProviderChain(semanticPrimary.name)
          .filter(name => name !== semanticPrimary.name)
          .map(name => name === 'groq_semantic' ? new GroqSemanticProvider() : new GeminiFreeSemanticProvider())]
      : [];
    const providerPromises = deterministicProviders.map(async provider => {
      const started = Date.now();
      const declared = provider.availability?.(input) || { availability: 'AVAILABLE' as const };
      if (declared.availability !== 'AVAILABLE') {
        return { items: [] as EvidenceItem[], report: { provider: provider.name, availability: declared.availability, evidenceCount: 0,
          outcome: declared.availability === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE' as const : 'UNAVAILABLE_CONFIGURATION' as const,
          reasonCodes: [declared.availability === 'NOT_APPLICABLE' ? 'PROVIDER_INPUT_NOT_APPLICABLE' : 'PROVIDER_CONFIGURATION_UNAVAILABLE'], reason: declared.reason, durationMs: Date.now()-started } };
      }
      try {
        const items = await provider.collectEvidence(input, knowledgeContext);
        const abstention=items.find(item=>item.category==='SEMANTIC_ABSTENTION');
        const semanticReasons=abstention?.provenance?.semantic?.reasonCodes || [];
        const unsupported=semanticReasons.some(code=>/UNSUPPORTED_LANGUAGE|LANGUAGE.*UNSUPPORTED/.test(code));
        return { items, report: { provider: provider.name, availability: 'AVAILABLE' as const, evidenceCount: items.filter(item=>item.rawMatches.length>0).length,
          outcome: abstention ? (unsupported ? 'ABSTAINED_UNSUPPORTED_LANGUAGE' as const : 'ABSTAINED_LOW_CONFIDENCE' as const) : items.length ? 'EXECUTED_WITH_EVIDENCE' as const : 'EXECUTED_NO_MATCH' as const,
          reasonCodes: abstention ? semanticReasons : [items.length ? 'PROVIDER_EVIDENCE_EMITTED' : 'PROVIDER_NO_GOVERNED_MATCH'], durationMs:Date.now()-started } };
      } catch (err: any) {
        console.warn(`[EvidenceEngine] Provider ${provider.name} error:`, err?.message || err);
        const timeout=err?.errorClass==='TIMEOUT'||/timeout|timed out|abort/i.test(String(err?.message||err));
        const errorClass=String(err?.errorClass||'UNKNOWN');
        return { items: [] as EvidenceItem[], report: { provider: provider.name, availability: 'FAILED' as const, evidenceCount: 0,
          outcome:timeout?'FAILED_TIMEOUT' as const:'FAILED_PROVIDER' as const,
          reasonCodes:safeProviderFailureReasonCodes(err,timeout),
          reason:`Provider failure (${errorClass}).`,durationMs:Date.now()-started } };
      }
    });

    const [deterministicResults, semanticResult] = await Promise.all([
      Promise.all(providerPromises),
      semanticPrimary
        ? executeSemanticChain(semanticChain, input, knowledgeContext)
        : Promise.resolve({ items: [] as EvidenceItem[], reports: [] as SemanticChainResult['reports'] }),
    ]);
    // Flatten chain attempts into the providers ledger: only the winning
    // (last) report carries items; every attempt stays visible for
    // provenance, metrics, and recovery decisions.
    const providerResults = [
      ...deterministicResults,
      ...semanticResult.reports.map((report, index) => ({
        items: index === semanticResult.reports.length - 1 ? semanticResult.items : ([] as EvidenceItem[]),
        report,
      })),
    ];
    const allEvidence = providerResults.flatMap(result => result.items);
    const provenanceErrors=validateEvidenceProvenance(allEvidence);
    const fieldsPresent = [
      input.channel_name?.trim() && 'channel_name', input.description?.trim() && 'description',
      input.video_titles?.length && 'video_titles', input.video_descriptions?.length && 'video_descriptions',
      input.external_links?.length && 'external_links', input.location_tag?.trim() && 'location_tag', input.discord_invite && 'discord_invite'
      , input.playlists?.length && 'playlists', input.detected_languages?.length && 'detected_languages'
      , input.transcript_excerpts?.length && 'transcript_excerpts', input.visual_evidence?.length && 'visual_evidence'
      , input.pinned_comment?.trim() && 'pinned_comment', input.activity_metadata && 'activity_metadata'
    ].filter(Boolean) as string[];
    const sparseMetadata = !input.description?.trim() && !(input.video_titles?.length) && !(input.video_descriptions?.length) && !(input.external_links?.length);
    // Optional, explicitly unavailable corroborators remain observable but do not
    // invalidate independently sufficient evidence. Runtime failures still fail
    // the availability gate conservatively.
    const degraded = providerResults.some(result => result.report.availability === 'FAILED');
    const explicitNegative = allEvidence.some(item => item.polarity === 'NEGATIVE' && item.category !== 'MULTI_VIDEO_CONSISTENCY');
    const hasSubstantiveContext = (input.description?.trim().length || 0) >= 40 || (input.video_titles?.length || 0) >= 2 || (input.external_links?.length || 0) > 0 || (input.playlists?.length || 0) > 0 || (input.transcript_excerpts?.length || 0) > 0;
    const substantiveEvidence=allEvidence.some(item=>item.rawMatches.length>0&&item.category!=='SEMANTIC_ABSTENTION');
    const sufficiency = fieldsPresent.length === 0 ? 'MISSING' : (substantiveEvidence || explicitNegative || hasSubstantiveContext) ? 'SUFFICIENT' : 'INSUFFICIENT';
    // Terminal negative decisions require creator-level coverage or independent
    // underlying observations. Multiple providers interpreting the same document
    // remain one observation and cannot manufacture rejection sufficiency.
    const negativeFields=allEvidence.filter(item=>item.polarity==='NEGATIVE').flatMap(item=>item.provenance?.fields||[]);
    const negativeObservationKeys=new Set(negativeFields.map(field=>field.sourceFamilyId||`${field.field}:${field.sourceId||field.index||''}`));
    const negativeSourceFamilies=new Set(negativeFields.map(field=>field.sourceFamilyId).filter((value):value is string=>!!value));
    const creatorLevelCoverage=(input.description?.trim().length||0)>=40&&negativeFields.some(field=>field.field==='channel_bio');
    const independentNegativeSupport=negativeObservationKeys.size>=2&&(negativeSourceFamilies.size>=2||new Set(negativeFields.map(field=>field.field==='video_title'||field.field==='video_description'?`video:${field.sourceId||field.index}`:field.field)).size>=2);
    const terminalNegativeSufficiency={status:creatorLevelCoverage||independentNegativeSupport?'SUFFICIENT' as const:'INSUFFICIENT' as const,creatorLevelCoverage,independentSourceFamilies:negativeSourceFamilies.size,independentObservations:negativeObservationKeys.size,reasonCodes:creatorLevelCoverage?['CREATOR_LEVEL_NEGATIVE_COVERAGE']:independentNegativeSupport?['INDEPENDENT_NEGATIVE_SUPPORT']:['TERMINAL_NEGATIVE_EVIDENCE_INSUFFICIENT']};
    const reasonCodes = [
      sparseMetadata && 'SPARSE_METADATA', degraded && 'PROVIDER_COVERAGE_DEGRADED',
      sufficiency === 'MISSING' && 'NO_CLASSIFIABLE_METADATA', sufficiency === 'INSUFFICIENT' && 'INSUFFICIENT_CLASSIFICATION_EVIDENCE'
      , ...provenanceErrors
    ].filter(Boolean) as string[];
    const collection: EvidenceCollectionReport = { sufficiency, sparseMetadata, degraded, fieldsPresent, reasonCodes, providers: providerResults.map(result => result.report),terminalNegativeSufficiency };

    // Evaluate decision deterministically via Scoring Strategy
    const stages = evaluateClassificationStages(input, allEvidence, collection);
    return this.decisionStrategy.evaluateDecision(allEvidence, knowledgeContext, country, collection, stages);
  }
}

// Global Singleton Instance
const defaultEngine = new EvidenceBasedTradingEngine();

export async function verifyChannelTradingRelevance(input: RawChannelInput): Promise<VerificationDecision> {
  return defaultEngine.evaluateChannel(input);
}

export * from './types';
export * from './config';
export * from './knowledgePacks';
export * from './scoringEngine';
export * from './reportGenerator';
export * from './stagedClassification';
export * from './canonicalEvidencePlane';
export * from './decisionPolicy';
export * from './documentTypes';
export * from './documentProjection';
export * from './documentSampling';
export * from './documentReplay';
export * from './providerV2';
export * from './coverage';
export * from './documentIndependence';
export * from './hypothesisTaxonomy';
export * from './documentSemanticProvider';
export * from './creatorFocusAggregation';
export * from './classifierV4';
