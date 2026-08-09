import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { FEATURED_CHANNEL_ADAPTER_POLICY_VERSION, featuredChannelActionKey, featuredChannelAdapterOutcome, featuredChannelFrontierTarget, parseFeaturedChannelSections, validateFeaturedChannelPayload } from './featuredChannelAdapter';
import { buildYouTubeApiUrl } from './youtube';

const sourceChannelId = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
const observedAt = '2026-08-09T00:00:00.000Z';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/youtube-channel-sections/${name}.json`, import.meta.url), 'utf8'));

test('fixture parsing retains only explicit multipleChannels IDs and normalizes deterministically', () => {
  const response = fixture('multiple-channels');
  const first = parseFeaturedChannelSections({ sourceChannelId, maximumFanout: 10, response, observedAt });
  const second = parseFeaturedChannelSections({ sourceChannelId, maximumFanout: 10, response: { ...response, items: [...response.items].reverse() }, observedAt });
  assert.deepEqual(first, second);
  assert.deepEqual(first.featuredChannelIds, ['UC9-y-6csu5WGm29I7JiwpnA', 'UCsXVk37bltHxD1rDPwtNM8Q', 'UCX6OQ3DkcsbYNE6H8uQQuVA']);
  assert.equal(first.boundedMetadata.sectionsConsidered, 2);
  assert.equal(first.boundedMetadata.nextPageIgnored, true);
  assert.equal(first.boundedMetadata.recursiveActionsCreated, 0);
  assert.equal(first.boundedMetadata.searchFallbackUsed, false);
});

test('duplicates, malformed IDs, self-links, and results beyond fanout are removed', () => {
  const parsed = parseFeaturedChannelSections({ sourceChannelId, maximumFanout: 2, response: fixture('multiple-channels'), observedAt });
  assert.deepEqual(parsed.featuredChannelIds, ['UC9-y-6csu5WGm29I7JiwpnA', 'UCsXVk37bltHxD1rDPwtNM8Q']);
  assert.equal(new Set(parsed.featuredChannelIds).size, parsed.featuredChannelIds.length);
  assert.ok(!parsed.featuredChannelIds.includes(sourceChannelId));
});

test('empty multipleChannels evidence is a successful deterministic observation', () => {
  const parsed = parseFeaturedChannelSections({ sourceChannelId, maximumFanout: 10, response: fixture('empty-sections'), observedAt });
  assert.deepEqual(parsed.featuredChannelIds, []);
  assert.deepEqual(parsed.observations, []);
  assert.equal(parsed.boundedMetadata.returned, 0);
  assert.equal(parsed.boundedMetadata.sectionsConsidered, 0);
});

test('malformed provider envelopes fail closed without inference', () => {
  for (const response of [null, [], {}, { items: null }]) assert.throws(() => parseFeaturedChannelSections({ sourceChannelId, maximumFanout: 10, response, observedAt }), /MALFORMED_FEATURED_CHANNEL_PROVIDER_RESPONSE/);
  const parsed = parseFeaturedChannelSections({ sourceChannelId, maximumFanout: 10, response: { items: [{ snippet: { type: 'multipleChannels' }, contentDetails: { channels: [null, 3, '@handle', 'channel name'] } }] }, observedAt });
  assert.deepEqual(parsed.featuredChannelIds, []);
});

test('durable payload requires exact source identities, policy, bounded fanout, and depth one', () => {
  const valid = { payloadSchemaVersion: 1, actionId: '11111111-1111-4111-8111-111111111111', programKey: 'de-futures', sourceChannelId, sourceCanonicalEntityId: '22222222-2222-4222-8222-222222222222', targetCountry: 'Germany', maximumFanout: 10, depth: 1, policyVersion: FEATURED_CHANNEL_ADAPTER_POLICY_VERSION };
  assert.deepEqual(validateFeaturedChannelPayload(valid), valid);
  assert.throws(() => validateFeaturedChannelPayload({ ...valid, sourceChannelId: '@handle' }), /SOURCE_CHANNEL_REQUIRED/);
  assert.throws(() => validateFeaturedChannelPayload({ ...valid, maximumFanout: 11 }), /FANOUT_OUT_OF_RANGE/);
  assert.throws(() => validateFeaturedChannelPayload({ ...valid, depth: 2 }), /DEPTH_MUST_BE_ONE/);
  assert.throws(() => validateFeaturedChannelPayload({ ...valid, policyVersion: 'other' }), /POLICY_MISMATCH/);
  assert.throws(() => validateFeaturedChannelPayload({ ...valid, query: 'related creators' }), /PAYLOAD_FIELDS/);
});

test('action and provider identities are replay-stable and input-sensitive', () => {
  const key = featuredChannelActionKey({ programKey: 'de-futures', sourceChannelId, validityStart: observedAt });
  assert.equal(key, featuredChannelActionKey({ programKey: 'de-futures', sourceChannelId, validityStart: observedAt }));
  assert.notEqual(key, featuredChannelActionKey({ programKey: 'fr-options', sourceChannelId, validityStart: observedAt }));
  const first = parseFeaturedChannelSections({ sourceChannelId, maximumFanout: 10, response: fixture('multiple-channels'), observedAt });
  const later = parseFeaturedChannelSections({ sourceChannelId, maximumFanout: 10, response: fixture('multiple-channels'), observedAt: '2026-08-10T00:00:00.000Z' });
  assert.equal(first.providerRequestIdentity, later.providerRequestIdentity);
  assert.equal(featuredChannelFrontierTarget(sourceChannelId), `channel:${sourceChannelId}`);
  assert.throws(() => featuredChannelFrontierTarget('@handle'), /SOURCE_CHANNEL_REQUIRED/);
  assert.deepEqual(Object.keys(featuredChannelAdapterOutcome(first)).sort(), ['boundedMetadata', 'featuredChannelIds', 'observationTimestamp', 'providerRequestIdentity', 'sourceChannelId']);
});

test('provider URL is exact, bounded, and contains no search or pagination surface', () => {
  const url = new URL(buildYouTubeApiUrl('channelSections', 'secret', { part: 'snippet,contentDetails', channelId: sourceChannelId, maxResults: 10 }));
  assert.equal(url.pathname, '/youtube/v3/channelSections');
  assert.equal(url.searchParams.get('part'), 'snippet,contentDetails');
  assert.equal(url.searchParams.get('channelId'), sourceChannelId);
  assert.equal(url.searchParams.get('maxResults'), '10');
  assert.equal(url.searchParams.has('pageToken'), false);
  assert.equal(url.searchParams.has('q'), false);
});

test('foundation migration is dormant, exact-type, immutable-ledger reuse only', () => {
  const sql = readFileSync(new URL('./db/migrations/079_featured_channel_adapter_foundation.sql', import.meta.url), 'utf8');
  assert.match(sql, /'INSPECT_FEATURED_CHANNELS','SHADOW',true,true,0,0,0,1,10/);
  assert.match(sql, /featured_channel_adapter_foundation_dormant/);
  assert.match(sql, /action_type IN\('SEARCH_TERM','CONTINUE_RESULT_PAGE','INSPECT_PLAYLIST','INSPECT_FEATURED_CHANNELS'\)/);
  assert.match(sql, /adapter_type IN\('INSPECT_PLAYLIST','INSPECT_FEATURED_CHANNELS'\)/);
  assert.match(sql, /featured_channel_adapter_outcome_contract/);
  assert.doesNotMatch(sql, /CREATE TABLE.*adapter_runs|INSERT INTO jobs|rollout_basis_points|serving_authority\s+BOOLEAN|INSPECT_COLLABORATOR|INSPECT_WEBSITE_AUTHOR|RESOLVE_EXTERNAL_ENTITY/i);
});

test('foundation is unreachable from production scheduling, queue, and Creator Intelligence authority', () => {
  for (const file of ['./queueManager.ts', './autonomousDiscovery.ts', './creatorIntelligence/canary.ts', './creatorIntelligence/authority.ts', './persistentResearchController.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /fetchYouTubeFeaturedChannels|featuredChannelAdapter|channelSections/);
  }
  const provider = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(provider, /INSERT INTO jobs|INSPECT_FEATURED_CHANNELS.*claim|enqueueFeatured/i);
});
