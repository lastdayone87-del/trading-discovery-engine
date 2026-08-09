import { createHash } from 'node:crypto';

export const FEATURED_CHANNEL_ADAPTER_POLICY_VERSION = 'featured-channel-adapter-v1';
export const FEATURED_CHANNEL_PAYLOAD_SCHEMA_VERSION = 1 as const;
export const FEATURED_CHANNEL_PROVIDER_COST = 1;
export const FEATURED_CHANNEL_MAX_FANOUT = 10;

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface InspectFeaturedChannelsJobPayloadV1 {
  payloadSchemaVersion: typeof FEATURED_CHANNEL_PAYLOAD_SCHEMA_VERSION;
  actionId: string;
  programKey: string;
  sourceChannelId: string;
  sourceCanonicalEntityId: string;
  targetCountry: string;
  maximumFanout: number;
  depth: 1;
  policyVersion: typeof FEATURED_CHANNEL_ADAPTER_POLICY_VERSION;
}

export interface FeaturedChannelObservation {
  sourceChannelId: string;
  featuredChannelId: string;
  sectionId: string;
  sectionTitle?: string;
  sectionPosition: number;
  targetPosition: number;
}

export interface FeaturedChannelProviderResult {
  sourceChannelId: string;
  featuredChannelIds: string[];
  observations: FeaturedChannelObservation[];
  providerRequestIdentity: string;
  observationTimestamp: string;
  boundedMetadata: { requestedMaximum: number; returned: number; sectionsConsidered: number; nextPageIgnored: boolean; recursiveActionsCreated: 0; searchFallbackUsed: false };
}

export interface FeaturedChannelAdapterOutcome {
  sourceChannelId: string;
  featuredChannelIds: string[];
  providerRequestIdentity: string;
  observationTimestamp: string;
  boundedMetadata: FeaturedChannelProviderResult['boundedMetadata'];
}

export function featuredChannelFrontierTarget(sourceChannelId: string): string {
  if (!CHANNEL_ID.test(sourceChannelId)) throw new Error('FEATURED_CHANNEL_SOURCE_CHANNEL_REQUIRED');
  return `channel:${sourceChannelId}`;
}

export function featuredChannelAdapterOutcome(result: FeaturedChannelProviderResult): FeaturedChannelAdapterOutcome {
  return { sourceChannelId: result.sourceChannelId, featuredChannelIds: [...result.featuredChannelIds], providerRequestIdentity: result.providerRequestIdentity, observationTimestamp: result.observationTimestamp, boundedMetadata: { ...result.boundedMetadata } };
}

export function validateFeaturedChannelPayload(value: unknown): InspectFeaturedChannelsJobPayloadV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_FEATURED_CHANNEL_PAYLOAD');
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload).sort();
  const expected = ['actionId', 'depth', 'maximumFanout', 'payloadSchemaVersion', 'policyVersion', 'programKey', 'sourceCanonicalEntityId', 'sourceChannelId', 'targetCountry'].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error('INVALID_FEATURED_CHANNEL_PAYLOAD_FIELDS');
  if (payload.payloadSchemaVersion !== 1 || payload.policyVersion !== FEATURED_CHANNEL_ADAPTER_POLICY_VERSION) throw new Error('FEATURED_CHANNEL_POLICY_MISMATCH');
  if (payload.depth !== 1) throw new Error('FEATURED_CHANNEL_DEPTH_MUST_BE_ONE');
  if (typeof payload.actionId !== 'string' || !UUID.test(payload.actionId) || typeof payload.sourceCanonicalEntityId !== 'string' || !UUID.test(payload.sourceCanonicalEntityId)) throw new Error('FEATURED_CHANNEL_EXACT_IDENTITY_REQUIRED');
  if (typeof payload.sourceChannelId !== 'string' || !CHANNEL_ID.test(payload.sourceChannelId)) throw new Error('FEATURED_CHANNEL_SOURCE_CHANNEL_REQUIRED');
  if (typeof payload.programKey !== 'string' || !payload.programKey.trim() || typeof payload.targetCountry !== 'string' || !payload.targetCountry.trim()) throw new Error('FEATURED_CHANNEL_CONTEXT_REQUIRED');
  if (!Number.isInteger(payload.maximumFanout) || Number(payload.maximumFanout) < 1 || Number(payload.maximumFanout) > FEATURED_CHANNEL_MAX_FANOUT) throw new Error('FEATURED_CHANNEL_FANOUT_OUT_OF_RANGE');
  return { payloadSchemaVersion: 1, actionId: payload.actionId, programKey: payload.programKey.trim(), sourceChannelId: payload.sourceChannelId, sourceCanonicalEntityId: payload.sourceCanonicalEntityId, targetCountry: payload.targetCountry.trim(), maximumFanout: Number(payload.maximumFanout), depth: 1, policyVersion: FEATURED_CHANNEL_ADAPTER_POLICY_VERSION };
}

export function featuredChannelActionKey(input: { programKey: string; sourceChannelId: string; validityStart: string; policyVersion?: string }): string {
  if (!input.programKey.trim() || !CHANNEL_ID.test(input.sourceChannelId) || !Number.isFinite(new Date(input.validityStart).getTime())) throw new Error('INVALID_FEATURED_CHANNEL_ACTION');
  return createHash('sha256').update(JSON.stringify({ programKey: input.programKey.trim(), sourceChannelId: input.sourceChannelId, validityStart: new Date(input.validityStart).toISOString(), actionType: 'INSPECT_FEATURED_CHANNELS', policyVersion: input.policyVersion || FEATURED_CHANNEL_ADAPTER_POLICY_VERSION })).digest('hex');
}

/** Parse one channelSections.list response; only explicit multipleChannels IDs are evidence. */
export function parseFeaturedChannelSections(input: { sourceChannelId: string; maximumFanout: number; response: unknown; observedAt: string }): FeaturedChannelProviderResult {
  if (!CHANNEL_ID.test(input.sourceChannelId) || !Number.isInteger(input.maximumFanout) || input.maximumFanout < 1 || input.maximumFanout > FEATURED_CHANNEL_MAX_FANOUT || !Number.isFinite(new Date(input.observedAt).getTime())) throw new Error('INVALID_FEATURED_CHANNEL_PROVIDER_INPUT');
  if (!input.response || typeof input.response !== 'object' || Array.isArray(input.response) || !Array.isArray((input.response as any).items)) throw new Error('MALFORMED_FEATURED_CHANNEL_PROVIDER_RESPONSE');
  const response = input.response as any;
  const sections = response.items.filter((item: any) => item && typeof item === 'object' && item.snippet?.type === 'multipleChannels' && Array.isArray(item.contentDetails?.channels))
    .map((item: any) => ({ id: String(item.id || ''), title: typeof item.snippet?.title === 'string' ? item.snippet.title : undefined, position: Number.isInteger(item.snippet?.position) ? item.snippet.position : Number.MAX_SAFE_INTEGER, channels: item.contentDetails.channels }))
    .sort((a: any, b: any) => a.position - b.position || a.id.localeCompare(b.id));
  const byChannel = new Map<string, FeaturedChannelObservation>();
  for (const section of sections) for (const [targetPosition, raw] of section.channels.entries()) {
    const featuredChannelId = typeof raw === 'string' ? raw.trim() : '';
    if (!CHANNEL_ID.test(featuredChannelId) || featuredChannelId === input.sourceChannelId || byChannel.has(featuredChannelId)) continue;
    byChannel.set(featuredChannelId, { sourceChannelId: input.sourceChannelId, featuredChannelId, sectionId: section.id, sectionTitle: section.title, sectionPosition: section.position, targetPosition });
  }
  const observations = [...byChannel.values()].sort((a, b) => a.featuredChannelId.localeCompare(b.featuredChannelId)).slice(0, input.maximumFanout);
  const observedAt = new Date(input.observedAt).toISOString();
  const providerRequestIdentity = createHash('sha256').update(JSON.stringify({ resource: 'channelSections', part: 'snippet,contentDetails', sourceChannelId: input.sourceChannelId, maximumResults: Math.min(50, input.maximumFanout), policyVersion: FEATURED_CHANNEL_ADAPTER_POLICY_VERSION })).digest('hex');
  return { sourceChannelId: input.sourceChannelId, featuredChannelIds: observations.map(item => item.featuredChannelId), observations, providerRequestIdentity, observationTimestamp: observedAt, boundedMetadata: { requestedMaximum: input.maximumFanout, returned: observations.length, sectionsConsidered: sections.length, nextPageIgnored: typeof response.nextPageToken === 'string' && response.nextPageToken.length > 0, recursiveActionsCreated: 0, searchFallbackUsed: false } };
}
