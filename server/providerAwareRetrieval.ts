import type { CountryVocabulary } from '../src/types';
import { searchYouTubeChannelPage, type DiscoveredChannelRaw, type RetrievalLane } from './youtube';
import type { SearchOrdering } from './searchOrdering';

export const YOUTUBE_SEARCH_PROVIDER = Object.freeze({
  providerKey: 'youtube-search',
  retrievalSurface: 'YOUTUBE_NATIVE',
  capability: 'SEARCH_YOUTUBE',
  costDomain: 'YOUTUBE_DATA_API',
  continuationOwner: 'PHASE_9'
} as const);

export type ProviderAllocation = typeof YOUTUBE_SEARCH_PROVIDER;
export interface RetrievalPage { channels: DiscoveredChannelRaw[]; rawResultCount: number; nextPageToken?: string | null }
export interface RetrievalRequest {
  provider: ProviderAllocation; query: string; country: string; vocabulary?: CountryVocabulary;
  lane: RetrievalLane; cursor: string | null; ordering: SearchOrdering;
  reserveAdditionalUnits?: (units:number)=>Promise<void>; priority?: 'autonomous'|'manual';
}

/** Phase 9's sole provider dispatch boundary. Unknown or mismatched allocations fail closed. */
export async function executeAllocatedRetrievalPage(request: RetrievalRequest):Promise<RetrievalPage> {
  const p=request.provider;
  if (p.providerKey!==YOUTUBE_SEARCH_PROVIDER.providerKey || p.retrievalSurface!==YOUTUBE_SEARCH_PROVIDER.retrievalSurface ||
      p.capability!==YOUTUBE_SEARCH_PROVIDER.capability || p.costDomain!==YOUTUBE_SEARCH_PROVIDER.costDomain ||
      p.continuationOwner!=='PHASE_9') throw new Error('UNREGISTERED_OR_MISMATCHED_RETRIEVAL_PROVIDER');
  return searchYouTubeChannelPage(request.query,request.country,request.vocabulary,request.lane,request.cursor,request.ordering,request.reserveAdditionalUnits,request.priority);
}

export function providerSnapshot(value:Partial<ProviderAllocation>|null|undefined):ProviderAllocation {
  if (!value) return YOUTUBE_SEARCH_PROVIDER;
  const snapshot={providerKey:value.providerKey,retrievalSurface:value.retrievalSurface,capability:value.capability,costDomain:value.costDomain,continuationOwner:value.continuationOwner} as ProviderAllocation;
  if (snapshot.providerKey!==YOUTUBE_SEARCH_PROVIDER.providerKey || snapshot.retrievalSurface!==YOUTUBE_SEARCH_PROVIDER.retrievalSurface ||
      snapshot.capability!==YOUTUBE_SEARCH_PROVIDER.capability || snapshot.costDomain!==YOUTUBE_SEARCH_PROVIDER.costDomain ||
      snapshot.continuationOwner!==YOUTUBE_SEARCH_PROVIDER.continuationOwner) throw new Error('INVALID_PROVIDER_ALLOCATION_SNAPSHOT');
  return Object.freeze(snapshot);
}

export function assertSameProviderAllocation(durable:unknown,payload:unknown):ProviderAllocation {
  const durableSnapshot=providerSnapshot(durable as Partial<ProviderAllocation>);
  const payloadSnapshot=providerSnapshot(payload as Partial<ProviderAllocation>);
  for(const key of Object.keys(YOUTUBE_SEARCH_PROVIDER) as Array<keyof ProviderAllocation>)
    if(durableSnapshot[key]!==payloadSnapshot[key])throw new Error('PHASE9_PROVIDER_LINEAGE_MISMATCH');
  return durableSnapshot;
}
