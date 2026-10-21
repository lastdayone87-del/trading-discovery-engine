import type { ChannelRecord, CommunityIntentEvidence } from '../types';

export interface CommunityIntentEvidenceView {
  key: string;
  platform: string;
  intent: string;
  url: string;
  displayUrl: string;
  signals: string[];
}

export interface CommunityIntentDisplay {
  present: boolean;
  label: string;
  tone: 'paid' | 'indicated';
  evidence: CommunityIntentEvidenceView[];
}

/**
 * Presentation-only projection for the dashboard. It never changes discovery
 * state: the persisted `community_discovery_status`/`community_intents` remain
 * authoritative, and a retained Discord invite is displayed independently.
 */
export function communityIntentDisplay(
  channel: Pick<ChannelRecord, 'community_discovery_status' | 'community_intents' | 'discord_invite' | 'discord_candidate_locator'>,
): CommunityIntentDisplay {
  const status = channel.community_discovery_status;
  const intents = channel.community_intents || [];
  const paidIntentItems = intents.filter(item => item?.communityUrl && item.intent === 'PAID');
  const paid = status === 'PAID_COMMUNITY_INDICATED' || intents.some(item => item.intent === 'PAID');
  const present = paid || status === 'COMMUNITY_INDICATED_NO_INVITE' || intents.length > 0;
  if (!present) {
    return { present: false, label: '', tone: 'indicated', evidence: [] };
  }

  // An additional community surface is not "no invite" when this channel
  // already retains a Discord invite or candidate. Keep the two facts
  // independent in the label so the table never contradicts itself.
  const hasDiscord = Boolean(channel.discord_invite || channel.discord_candidate_locator);

  // Paid evidence can sit beyond the first three stored records. Put those
  // records first so the displayed evidence (and the platform named in the
  // label) always includes the platform that established paid intent.
  const orderedIntents = paid && paidIntentItems.length > 0
    ? [...paidIntentItems, ...intents]
    : intents;
  const seen = new Set<string>();
  const evidence: CommunityIntentEvidenceView[] = [];
  for (const item of orderedIntents) {
    if (!item?.communityUrl || seen.has(item.communityUrl)) continue;
    seen.add(item.communityUrl);
    evidence.push(evidenceView(item));
    if (evidence.length >= 3) break;
  }

  // Count platforms across every eligible stored intent, not only the three
  // displayed entries, so the "+N" suffix never undercounts. A paid summary
  // names only the platforms that carry paid intent.
  const suffixIntents = paid ? paidIntentItems : intents;
  const platforms = [...new Set(suffixIntents
    .filter(item => item?.communityUrl)
    .map(item => platformLabel(item.communityPlatform)))];
  const platformSuffix = platforms.length > 0 ? ` (${platforms.slice(0, 2).join(', ')}${platforms.length > 2 ? ', +' + (platforms.length - 2) : ''})` : '';
  const label = paid
    ? `Paid community${platformSuffix}`
    : hasDiscord
      ? `Additional community${platformSuffix}`
      : `Community indicated${platformSuffix} · no invite`;

  return { present: true, label, tone: paid ? 'paid' : 'indicated', evidence };
}

function platformLabel(platform: string): string {
  const known: Record<string, string> = {
    WHOP: 'Whop',
    SKOOL: 'Skool',
    CIRCLE: 'Circle',
    PATREON: 'Patreon',
    DISCORD: 'Discord',
  };
  return known[platform.toUpperCase()] || platform;
}

function evidenceView(item: CommunityIntentEvidence): CommunityIntentEvidenceView {
  const signals = [...new Set([...(item.paidSignals || []), ...(item.privateSignals || [])])].slice(0, 5);
  return {
    key: `${item.communityPlatform}:${item.communityUrl}`,
    platform: platformLabel(item.communityPlatform),
    intent: item.intent,
    url: item.communityUrl,
    displayUrl: item.communityUrl.replace(/^https?:\/\//, '').replace(/^www\./, ''),
    signals,
  };
}
