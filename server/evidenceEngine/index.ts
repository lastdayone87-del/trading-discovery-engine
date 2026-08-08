import { EvidenceCollectionReport, EvidenceItem, EvidenceProvider, RawChannelInput, VerificationDecision, ScoringEngineConfig } from './types';
import { getLayeredKnowledgeContext, LANGUAGE_KNOWLEDGE_PACKS } from './knowledgePacks';
import { ChannelMetadataProvider } from './providers/ChannelMetadataProvider';
import { VideoMetadataProvider } from './providers/VideoMetadataProvider';
import { ExternalLinkProvider } from './providers/ExternalLinkProvider';
import { CountryKnowledgeProvider } from './providers/CountryKnowledgeProvider';
import { GeminiSemanticProvider } from './providers/GeminiSemanticProvider';
import { DiscordProvider } from './providers/DiscordProvider';
import { MultilingualContextProvider } from './providers/MultilingualContextProvider';
import { ConfigurableWeightedStrategy } from './scoringEngine';
import { evaluateClassificationStages } from './stagedClassification';
import { buildCanonicalEvidenceCorpus, validateEvidenceProvenance } from './canonicalEvidencePlane';
import { contentLanguagePacks } from './multilingualTerminology';

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

    // Collect evidence from all independent providers in parallel
    const providerPromises = this.providers.map(async provider => {
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
        const timeout=/timeout|timed out|abort/i.test(String(err?.message||err));
        return { items: [] as EvidenceItem[], report: { provider: provider.name, availability: 'FAILED' as const, evidenceCount: 0,
          outcome:timeout?'FAILED_TIMEOUT' as const:'FAILED_PROVIDER' as const,reasonCodes:[timeout?'PROVIDER_TIMEOUT':'PROVIDER_EXECUTION_FAILED'],reason: String(err?.message || err || 'Unknown provider failure'),durationMs:Date.now()-started } };
      }
    });

    const providerResults = await Promise.all(providerPromises);
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
