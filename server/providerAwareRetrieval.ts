import type { CountryVocabulary } from '../src/types';
import { searchYouTubeChannelPage, type DiscoveredChannelRaw, type RetrievalLane } from './youtube';
import type { SearchOrdering } from './searchOrdering';

export interface ProviderAllocation {
  providerKey: string;
  retrievalSurface: string;
  capability: string;
  costDomain: string;
  continuationOwner: 'PHASE_9';
}

export const YOUTUBE_SEARCH_PROVIDER: ProviderAllocation = Object.freeze({
  providerKey: 'youtube-search',
  retrievalSurface: 'YOUTUBE_NATIVE',
  capability: 'SEARCH_YOUTUBE',
  costDomain: 'YOUTUBE_DATA_API',
  continuationOwner: 'PHASE_9'
});

/**
 * SHADOW is never eligible for ordinary allocation. The only exception is the
 * explicitly admin-gated, exactly-one-run Brave direct-search canary path.
 */
export function isShadowBraveCanaryAllowed(input: {
  mode: string;
  providerKey: string;
  capability: string;
  allowShadowProvider?: boolean;
}): boolean {
  return input.mode === 'SHADOW' &&
    input.allowShadowProvider === true &&
    input.providerKey === 'brave-search' &&
    input.capability === 'SEARCH_BRAVE_DIRECT';
}

export interface RetrievalPage {
  channels: DiscoveredChannelRaw[];
  rawResultCount: number;
  nextPageToken?: string | null;
  providerCostUsd?: number;
  providerRequestId?: string;
}
export interface RetrievalRequest {
  provider: ProviderAllocation; query: string; country: string; vocabulary?: CountryVocabulary;
  lane: RetrievalLane; cursor: string | null; ordering: SearchOrdering;
  queryRunId?: string;
  /** Stable logical page identity; provider attempts append their attempt number. */
  requestId?: string;
  /** Durable queue job identity for provider-event correlation. */
  jobId?: string;
  /** Optional language selected by persisted query/evidence metadata. */
  preferredLanguage?: string;
  reserveAdditionalUnits?: (units:number)=>Promise<void>;
  priority?: 'autonomous'|'manual';
}

export type RetrievalExecutor = (request: RetrievalRequest) => Promise<RetrievalPage>;

export function buildProviderRequestBaseId(input: {
  queryRunId: string;
  jobId: string;
  jobAttempt: number;
  pageNumber: number;
}): string {
  return `query-run:${input.queryRunId}:job:${input.jobId}:attempt:${input.jobAttempt}:page:${input.pageNumber}`;
}

const registeredExecutors = new Map<string, { provider: ProviderAllocation; executor: RetrievalExecutor }>();

export function registerRetrievalExecutor(
  provider: ProviderAllocation,
  executor: RetrievalExecutor
): void {
  if (
    !provider ||
    typeof provider.providerKey !== 'string' || !provider.providerKey ||
    typeof provider.retrievalSurface !== 'string' || !provider.retrievalSurface ||
    typeof provider.capability !== 'string' || !provider.capability ||
    typeof provider.costDomain !== 'string' || !provider.costDomain ||
    provider.continuationOwner !== 'PHASE_9'
  ) {
    throw new Error('INVALID_PROVIDER_REGISTRATION');
  }
  const fullKey = `${provider.providerKey}:${provider.retrievalSurface}`;
  const entry = { provider: Object.freeze({ ...provider }), executor };
  registeredExecutors.set(fullKey, entry);
}

export function clearRegisteredExecutorsForTest(): void {
  registeredExecutors.clear();
  registerDefaultExecutors();
}

function registerDefaultExecutors(): void {
  registerRetrievalExecutor(YOUTUBE_SEARCH_PROVIDER, async (request) => {
    return searchYouTubeChannelPage(
      request.query, request.country, request.vocabulary, request.lane, request.cursor, request.ordering, request.reserveAdditionalUnits, request.priority,
      { requestId: request.requestId, runId: request.queryRunId, jobId: request.jobId, preferredLanguage: request.preferredLanguage }
    );
  });
}

registerDefaultExecutors();

export function providerSnapshot(value: Partial<ProviderAllocation> | null | undefined): ProviderAllocation {
  if (!value) return YOUTUBE_SEARCH_PROVIDER;
  const key = value.providerKey;
  if (
    !key || typeof key !== 'string' ||
    !value.retrievalSurface || typeof value.retrievalSurface !== 'string' ||
    !value.capability || typeof value.capability !== 'string' ||
    !value.costDomain || typeof value.costDomain !== 'string' ||
    value.continuationOwner !== 'PHASE_9'
  ) {
    throw new Error('INVALID_PROVIDER_ALLOCATION_SNAPSHOT');
  }

  const snapshot: ProviderAllocation = {
    providerKey: key,
    retrievalSurface: value.retrievalSurface,
    capability: value.capability,
    costDomain: value.costDomain,
    continuationOwner: 'PHASE_9'
  };

  const fullKey = `${key}:${snapshot.retrievalSurface}`;
  const registered = registeredExecutors.get(fullKey);
  if (registered) {
    if (
      snapshot.retrievalSurface !== registered.provider.retrievalSurface ||
      snapshot.capability !== registered.provider.capability ||
      snapshot.costDomain !== registered.provider.costDomain ||
      snapshot.continuationOwner !== registered.provider.continuationOwner
    ) {
      throw new Error('UNREGISTERED_OR_MISMATCHED_RETRIEVAL_PROVIDER');
    }
  }

  return Object.freeze(snapshot);
}

/** Phase 9's sole provider dispatch boundary. Unknown or mismatched allocations fail closed. */
export async function executeAllocatedRetrievalPage(request: RetrievalRequest): Promise<RetrievalPage> {
  const p = providerSnapshot(request.provider);
  const fullKey = `${p.providerKey}:${p.retrievalSurface}`;
  const entry = registeredExecutors.get(fullKey);
  if (!entry) {
    throw new Error('UNREGISTERED_OR_MISMATCHED_RETRIEVAL_PROVIDER');
  }

  if (
    p.retrievalSurface !== entry.provider.retrievalSurface ||
    p.capability !== entry.provider.capability ||
    p.costDomain !== entry.provider.costDomain ||
    p.continuationOwner !== entry.provider.continuationOwner
  ) {
    throw new Error('UNREGISTERED_OR_MISMATCHED_RETRIEVAL_PROVIDER');
  }

  return entry.executor(request);
}
