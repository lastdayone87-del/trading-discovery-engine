import type { ChannelRecord } from '../src/types';
import {
  fetchYouTubeChannelCountryMetadata,
  type DiscoveredChannelRaw,
} from './youtube';
import { applyPublicAboutToCandidate, fetchLiveYouTubeChannelData } from './youtubePublicAbout';
import { parseSubscriberCountNumber, sanitizeSubscriberCountText } from './lowAudienceGate';
import { OfficialYouTubeQuotaFenceError } from './officialYouTubeQuotaFence';
import { isProbeQuotaControlError, YouTubeKeyCapUnavailableError } from './quotaKeyCapShadow';
import { isYouTubeQuotaAccountingError } from './youtubeKeyHealth';

/** Successful subscriber evidence is reused for this long before a refresh. */
export const SUBSCRIBER_COUNT_MAX_AGE_DAYS = 30;
const SUBSCRIBER_COUNT_MAX_AGE_MS = SUBSCRIBER_COUNT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/**
 * One official channels.list attempt (which may rotate keys internally) plus
 * one keyless public About attempt. A missing count after both is a failed
 * fetch, not an unknown failure that may pass the audience gate.
 */
export const SUBSCRIBER_EVIDENCE_MAX_ATTEMPTS = 2;

export type SubscriberEvidenceState = 'KNOWN' | 'HIDDEN' | 'FAILED';

export interface SubscriberEvidenceResolution {
  candidate: DiscoveredChannelRaw;
  state: SubscriberEvidenceState;
  attempts: number;
  changed: boolean;
  /** A stale known count remained usable because refresh attempts failed. */
  stale?: boolean;
}

export interface SubscriberEvidenceDeps {
  fetchOfficial?: typeof fetchYouTubeChannelCountryMetadata;
  fetchPublic?: typeof fetchLiveYouTubeChannelData;
  now?: () => number;
}

export function subscriberEvidenceCheckedAtFromChannel(
  channel: Pick<ChannelRecord, 'country_metadata_checked_at' | 'public_about_checked_at' | 'last_checked'>,
): string | undefined {
  return channel.country_metadata_checked_at || channel.public_about_checked_at || channel.last_checked || undefined;
}

export function isFreshSubscriberCount(
  count: string | undefined,
  checkedAt: string | undefined,
  now = Date.now(),
): boolean {
  if (parseSubscriberCountNumber(count) === undefined) return false;
  if (!checkedAt) return true; // legacy value with no timestamp: do not mass-refresh it
  const observed = Date.parse(checkedAt);
  if (!Number.isFinite(observed)) return true;
  return now - observed <= SUBSCRIBER_COUNT_MAX_AGE_MS;
}

/** Seed candidate evidence from a durable row before deciding whether to fetch. */
export function applyChannelSubscriberEvidenceToCandidate(
  candidate: DiscoveredChannelRaw,
  channel: Pick<ChannelRecord, 'subscriber_count' | 'subscriber_count_hidden' | 'country_metadata_checked_at' | 'public_about_checked_at' | 'last_checked'> | null | undefined,
): DiscoveredChannelRaw {
  if (!channel) return candidate;
  if (channel.subscriber_count_hidden === true) {
    candidate.subscriberCountHidden = true;
    return candidate;
  }
  if (parseSubscriberCountNumber(candidate.subscriberCount) === undefined
    && parseSubscriberCountNumber(channel.subscriber_count) !== undefined) {
    candidate.subscriberCount = channel.subscriber_count;
    candidate.subscriberCountCheckedAt = subscriberEvidenceCheckedAtFromChannel(channel);
  }
  return candidate;
}

/** Copy resolved candidate evidence onto a durable channel row. */
export function applySubscriberEvidenceToChannel(
  channel: ChannelRecord,
  candidate: Pick<DiscoveredChannelRaw, 'subscriberCount' | 'subscriberCountHidden'>,
): void {
  if (candidate.subscriberCountHidden === true) {
    channel.subscriber_count_hidden = true;
  }
  const count = sanitizeSubscriberCountText(candidate.subscriberCount);
  if (count !== undefined) channel.subscriber_count = count;
}

export function currentSubscriberEvidenceState(
  candidate: Pick<DiscoveredChannelRaw, 'subscriberCount' | 'subscriberCountHidden' | 'subscriberCountCheckedAt'>,
  now = Date.now(),
): SubscriberEvidenceState | 'STALE' | 'MISSING' {
  if (candidate.subscriberCountHidden === true) return 'HIDDEN';
  const count = sanitizeSubscriberCountText(candidate.subscriberCount);
  if (count === undefined) return 'MISSING';
  return isFreshSubscriberCount(count, candidate.subscriberCountCheckedAt, now) ? 'KNOWN' : 'STALE';
}

/**
 * The single subscriber-evidence acquisition path.
 *
 * Reuses a fresh candidate/channel count, otherwise performs one official
 * channels.list hydration and, when allowed, one keyless public About fallback.
 * Hidden is terminal (never retried, never low). A failed refresh of an
 * already-known stale count keeps that last-known count; a failed fetch with no
 * count is FAILED so callers cannot treat unknown as passing.
 */
export async function ensureSubscriberEvidence(
  input: DiscoveredChannelRaw,
  options: SubscriberEvidenceDeps & { allowPublicFallback?: boolean } = {},
): Promise<SubscriberEvidenceResolution> {
  const nowMs = (options.now || Date.now)();
  const now = new Date(nowMs).toISOString();
  const fetchOfficial = options.fetchOfficial || fetchYouTubeChannelCountryMetadata;
  const fetchPublic = options.fetchPublic || fetchLiveYouTubeChannelData;
  const candidate: DiscoveredChannelRaw = { ...input };
  const beforeCount = sanitizeSubscriberCountText(candidate.subscriberCount);
  const beforeCheckedAt = candidate.subscriberCountCheckedAt;
  const beforeHidden = candidate.subscriberCountHidden === true;

  if (beforeHidden) {
    return { candidate, state: 'HIDDEN', attempts: 0, changed: false };
  }
  if (beforeCount !== undefined && isFreshSubscriberCount(beforeCount, beforeCheckedAt, nowMs)) {
    return { candidate, state: 'KNOWN', attempts: 0, changed: false };
  }

  let attempts = 0;
  try {
    attempts += 1;
    const official = await fetchOfficial(candidate.channelId, candidate);
    Object.assign(candidate, official);
    if (candidate.subscriberCountHidden === true) {
      return { candidate, state: 'HIDDEN', attempts, changed: beforeHidden !== true };
    }
    const officialCount = sanitizeSubscriberCountText(candidate.subscriberCount);
    if (officialCount !== undefined
      && isFreshSubscriberCount(officialCount, candidate.subscriberCountCheckedAt, nowMs)) {
      return { candidate, state: 'KNOWN', attempts, changed: officialCount !== beforeCount };
    }
  } catch (error) {
    // Quota policy/accounting failures are retryable infrastructure signals,
    // not evidence failures. Propagate them to the caller's existing lifecycle.
    if (error instanceof OfficialYouTubeQuotaFenceError
      || error instanceof YouTubeKeyCapUnavailableError
      || isProbeQuotaControlError(error)
      || isYouTubeQuotaAccountingError(error)) {
      throw error;
    }
    // Other provider/network failures fall through to the keyless source.
  }

  if (options.allowPublicFallback !== false) {
    try {
      attempts += 1;
      const liveAbout = await fetchPublic(candidate.youtubeUrl);
      if (liveAbout) {
        const applied = applyPublicAboutToCandidate(candidate, liveAbout);
        (candidate as any).publicAboutCheckedAt = now;
        (candidate as any).publicAboutAttempts = Number((candidate as any).publicAboutAttempts || 0) + 1;
        (candidate as any).publicAboutStatus = applied ? 'ATTEMPTED_SUCCEEDED' : 'ATTEMPTED_EMPTY';
        const publicCount = sanitizeSubscriberCountText(candidate.subscriberCount);
        if (publicCount !== undefined) {
          candidate.subscriberCount = publicCount;
          candidate.subscriberCountCheckedAt = now;
          return { candidate, state: 'KNOWN', attempts, changed: publicCount !== beforeCount };
        }
      } else {
        (candidate as any).publicAboutCheckedAt = now;
        (candidate as any).publicAboutAttempts = Number((candidate as any).publicAboutAttempts || 0) + 1;
        (candidate as any).publicAboutStatus = 'ATTEMPTED_FAILED';
      }
    } catch {
      // Keep the last-known count below; otherwise this is a failed fetch.
    }
  }

  if (beforeCount !== undefined) {
    candidate.subscriberCount = beforeCount;
    candidate.subscriberCountCheckedAt = beforeCheckedAt;
    return { candidate, state: 'KNOWN', attempts, changed: false, stale: true };
  }
  return { candidate, state: 'FAILED', attempts, changed: false };
}
