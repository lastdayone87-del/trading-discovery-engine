import { EvidenceCollectionReport, EvidenceItem, EvidenceProvider, RawChannelInput, VerificationDecision, ScoringEngineConfig } from './types';
import { getLayeredKnowledgeContext } from './knowledgePacks';
import { ChannelMetadataProvider } from './providers/ChannelMetadataProvider';
import { VideoMetadataProvider } from './providers/VideoMetadataProvider';
import { ExternalLinkProvider } from './providers/ExternalLinkProvider';
import { CountryKnowledgeProvider } from './providers/CountryKnowledgeProvider';
import { GeminiSemanticProvider } from './providers/GeminiSemanticProvider';
import { DiscordProvider } from './providers/DiscordProvider';
import { MultilingualContextProvider } from './providers/MultilingualContextProvider';
import { ConfigurableWeightedStrategy } from './scoringEngine';
import { evaluateClassificationStages } from './stagedClassification';

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
    const country = input.country || 'UNKNOWN';
    const knowledgeContext = getLayeredKnowledgeContext(country);

    // Collect evidence from all independent providers in parallel
    const providerPromises = this.providers.map(async provider => {
      const declared = provider.availability?.(input) || { availability: 'AVAILABLE' as const };
      if (declared.availability !== 'AVAILABLE') {
        return { items: [] as EvidenceItem[], report: { provider: provider.name, availability: declared.availability, evidenceCount: 0, reason: declared.reason } };
      }
      try {
        const items = await provider.collectEvidence(input, knowledgeContext);
        return { items, report: { provider: provider.name, availability: 'AVAILABLE' as const, evidenceCount: items.length } };
      } catch (err: any) {
        console.warn(`[EvidenceEngine] Provider ${provider.name} error:`, err?.message || err);
        return { items: [] as EvidenceItem[], report: { provider: provider.name, availability: 'FAILED' as const, evidenceCount: 0, reason: String(err?.message || err || 'Unknown provider failure') } };
      }
    });

    const providerResults = await Promise.all(providerPromises);
    const allEvidence = providerResults.flatMap(result => result.items);
    const fieldsPresent = [
      input.channel_name?.trim() && 'channel_name', input.description?.trim() && 'description',
      input.video_titles?.length && 'video_titles', input.video_descriptions?.length && 'video_descriptions',
      input.external_links?.length && 'external_links', input.location_tag?.trim() && 'location_tag', input.discord_invite && 'discord_invite'
      , input.playlists?.length && 'playlists', input.detected_languages?.length && 'detected_languages'
      , input.transcript_excerpts?.length && 'transcript_excerpts', input.visual_evidence?.length && 'visual_evidence'
    ].filter(Boolean) as string[];
    const sparseMetadata = !input.description?.trim() && !(input.video_titles?.length) && !(input.video_descriptions?.length) && !(input.external_links?.length);
    const degraded = providerResults.some(result => result.report.availability === 'FAILED' || result.report.availability === 'UNAVAILABLE');
    const explicitNegative = allEvidence.some(item => item.polarity === 'NEGATIVE' && item.category !== 'MULTI_VIDEO_CONSISTENCY');
    const hasSubstantiveContext = (input.description?.trim().length || 0) >= 40 || (input.video_titles?.length || 0) >= 2 || (input.external_links?.length || 0) > 0 || (input.playlists?.length || 0) > 0 || (input.transcript_excerpts?.length || 0) > 0;
    const sufficiency = fieldsPresent.length === 0 ? 'MISSING' : (allEvidence.length > 0 || explicitNegative || hasSubstantiveContext) ? 'SUFFICIENT' : 'INSUFFICIENT';
    const reasonCodes = [
      sparseMetadata && 'SPARSE_METADATA', degraded && 'PROVIDER_COVERAGE_DEGRADED',
      sufficiency === 'MISSING' && 'NO_CLASSIFIABLE_METADATA', sufficiency === 'INSUFFICIENT' && 'INSUFFICIENT_CLASSIFICATION_EVIDENCE'
    ].filter(Boolean) as string[];
    const collection: EvidenceCollectionReport = { sufficiency, sparseMetadata, degraded, fieldsPresent, reasonCodes, providers: providerResults.map(result => result.report) };

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
