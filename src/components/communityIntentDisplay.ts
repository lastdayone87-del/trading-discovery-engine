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
  channel: Pick<ChannelRecord, 'community_discovery_status' | 'community_intents'>,
): CommunityIntentDisplay {
  const status = channel.community_discovery_status;
  const intents = channel.community_intents || [];
  const paid = status === 'PAID_COMMUNITY_INDICATED' || intents.some(item => item.intent === 'PAID');
  const present = paid || status === 'COMMUNITY_INDICATED_NO_INVITE' || intents.length > 0;
  if (!present) {
    return { present: false, label: '', tone: 'indicated', evidence: [] };
  }

  const label = paid ? 'PAID COMMUNITY INDICATED' : 'COMMUNITY INDICATED · NO INVITE';
  const seen = new Set<string>();
  const evidence: CommunityIntentEvidenceView[] = [];
  for (const item of intents) {
    if (!item?.communityUrl || seen.has(item.communityUrl)) continue;
    seen.add(item.communityUrl);
    evidence.push(evidenceView(item));
    if (evidence.length >= 3) break;
  }

  return { present: true, label, tone: paid ? 'paid' : 'indicated', evidence };
}

function evidenceView(item: CommunityIntentEvidence): CommunityIntentEvidenceView {
  const signals = [...new Set([...(item.paidSignals || []), ...(item.privateSignals || [])])].slice(0, 5);
  return {
    key: `${item.communityPlatform}:${item.communityUrl}`,
    platform: item.communityPlatform,
    intent: item.intent,
    url: item.communityUrl,
    displayUrl: item.communityUrl.replace(/^https?:\/\//, '').replace(/^www\./, ''),
    signals,
  };
}
