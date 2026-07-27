import { EvidenceItem, EvidenceProvider, RawChannelInput, LayeredKnowledgeContext } from '../types';

export class DiscordProvider implements EvidenceProvider {
  name = 'discord_metadata' as const;

  async collectEvidence(input: RawChannelInput, _knowledgeContext: LayeredKnowledgeContext): Promise<EvidenceItem[]> {
    const items: EvidenceItem[] = [];
    const invite = input.discord_invite;
    const now = new Date().toISOString();

    if (invite) {
      items.push({
        id: `discord_invite_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        source: 'discord_metadata',
        polarity: 'POSITIVE',
        category: 'EXTERNAL_RESOURCE',
        fact: `Creator maintains an active community Discord server link: ${invite}`,
        rawMatches: [invite],
        confidence: 85,
        reliability: 'HIGH',
        reliabilityMultiplier: 0.85,
        rawWeight: 10,
        finalWeight: 10 * 0.85 * 0.85,
        provenance: {
          provider: 'discord_metadata',
          type: 'EXTERNAL_RESOURCE',
          matchedTerm: invite,
          sourceRef: 'Discord Invite'
        },
        timestamp: now
      });
    }

    return items;
  }
}
