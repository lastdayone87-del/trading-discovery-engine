import type { ChannelRecord, CommunityIntentEvidence } from '../types';
import { isPlatformOwnedCommunityUrl } from '../utils/platformOwnedPages';

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
  // Platform-owned marketing/docs/newsroom/asset pages can carry price
  // wording without describing the creator's own community. They are not
  // community intent at all: remove them from the badge, the evidence list,
  // and the platform suffix. Genuine creator-specific evidence still counts,
  // and mixed evidence keeps only the creator-specific records. This is a
  // presentation projection; persisted status and stored evidence are not
  // changed.
  const creatorIntents = intents.filter(
    item => item?.communityUrl && !isPlatformOwnedCommunityUrl(item.communityPlatform, item.communityUrl),
  );
  const creatorPaidIntentItems = creatorIntents.filter(item => item.intent === 'PAID');
  const onlyPlatformOwnedIntents = intents.some(item => item?.communityUrl) && creatorIntents.length === 0;
  const paid = !onlyPlatformOwnedIntents
    && (status === 'PAID_COMMUNITY_INDICATED' || creatorPaidIntentItems.length > 0);
  // A status-only indication (no stored URLs) remains visible. If the only
  // stored evidence is platform-owned, there is no community intent to show.
  const present = !onlyPlatformOwnedIntents
    && (paid || status === 'COMMUNITY_INDICATED_NO_INVITE' || creatorIntents.length > 0);
  if (!present) {
    return { present: false, label: '', tone: 'indicated', evidence: [] };
  }

  // An additional community surface is not "no invite" when this channel
  // already retains a Discord invite or candidate. Keep the two facts
  // independent in the label so the table never contradicts itself.
  const hasDiscord = Boolean(channel.discord_invite || channel.discord_candidate_locator);

  // Creator-specific paid evidence can sit beyond the first three stored
  // records. Put those records first so the displayed evidence (and the
  // platform named in the label) always includes the platform that
  // established genuine paid intent. Platform-owned records are excluded.
  const orderedIntents = paid && creatorPaidIntentItems.length > 0
    ? [...creatorPaidIntentItems, ...creatorIntents]
    : creatorIntents;
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
  // names only the platforms that carry creator-specific paid intent; when
  // the badge comes from the persisted status alone (no classified paid
  // records), the suffix stays empty exactly as before.
  const suffixIntents = paid ? creatorPaidIntentItems : intents;
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

function platformLabel(platform: string | null | undefined): string {
  // Persisted JSONB is not schema-validated: an older record without a
  // platform, or with a non-string value, must not break the whole table
  // render.
  if (typeof platform !== 'string' || !platform) return 'Other';
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
