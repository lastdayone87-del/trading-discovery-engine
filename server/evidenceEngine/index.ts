import { EvidenceItem, EvidenceProvider, RawChannelInput, VerificationDecision, ScoringEngineConfig } from './types';
import { getLayeredKnowledgeContext } from './knowledgePacks';
import { ChannelMetadataProvider } from './providers/ChannelMetadataProvider';
import { VideoMetadataProvider } from './providers/VideoMetadataProvider';
import { ExternalLinkProvider } from './providers/ExternalLinkProvider';
import { CountryKnowledgeProvider } from './providers/CountryKnowledgeProvider';
import { GeminiSemanticProvider } from './providers/GeminiSemanticProvider';
import { DiscordProvider } from './providers/DiscordProvider';
import { ConfigurableWeightedStrategy } from './scoringEngine';

export class EvidenceBasedTradingEngine {
  private providers: EvidenceProvider[];
  private decisionStrategy: ConfigurableWeightedStrategy;

  constructor(customProviders?: EvidenceProvider[], customConfig?: Partial<ScoringEngineConfig>) {
    this.providers = customProviders || [
      new ChannelMetadataProvider(),
      new VideoMetadataProvider(),
      new ExternalLinkProvider(),
      new CountryKnowledgeProvider(),
      new GeminiSemanticProvider(),
      new DiscordProvider()
    ];
    this.decisionStrategy = new ConfigurableWeightedStrategy(customConfig);
  }

  public async evaluateChannel(input: RawChannelInput): Promise<VerificationDecision> {
    const country = input.country || 'UNKNOWN';
    const knowledgeContext = getLayeredKnowledgeContext(country);

    // Collect evidence from all independent providers in parallel
    const providerPromises = this.providers.map(provider =>
      provider.collectEvidence(input, knowledgeContext).catch(err => {
        console.warn(`[EvidenceEngine] Provider ${provider.name} error:`, err?.message || err);
        return [] as EvidenceItem[];
      })
    );

    const providerResults = await Promise.all(providerPromises);
    const allEvidence = providerResults.flat();

    // Evaluate decision deterministically via Scoring Strategy
    return this.decisionStrategy.evaluateDecision(allEvidence, knowledgeContext, country);
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
