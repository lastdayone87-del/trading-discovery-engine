import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import type { ChannelRecord } from '../src/types';
import { getDb, getChannelById, listChannelsPage, upsertChannel } from './db';
import { applyCommunityIntentEvidence, extractCommunityIntentEvidence } from './communityIntent';

const enabled = Boolean(process.env.DATABASE_URL);
const maybe = enabled ? test : test.skip;
const channelId = 'community-intent-retained-invite-fixture';
const channelName = 'Community Intent Retained Invite Fixture';

after(async () => {
  if (!enabled) return;
  const db = await getDb();
  await db.query('DELETE FROM channels WHERE channel_id=$1', [channelId]);
  await db.end();
});

maybe('retained invite and additional intent coexist in the persisted row and /api/channels payload', async () => {
  const db = await getDb();
  await db.query('DELETE FROM channels WHERE channel_id=$1', [channelId]);
  const now = new Date().toISOString();
  const record: ChannelRecord = {
    channel_id: channelId,
    channel_name: channelName,
    youtube_url: 'https://youtube.test/community-intent-fixture',
    country: 'United States',
    country_status: 'CONFIRMED',
    scope_eligibility: 'IN_SCOPE',
    confidence_score: 90,
    discord_status: 'ACTIVE',
    discord_invite: 'https://discord.gg/creatora',
    discord_discovery_status: 'VALIDATED',
    discord_candidate_locator: 'https://discord.gg/creatora',
    discord_candidate_id: 'fixture-candidate',
    discord_candidate_raw_locator: 'discord.gg/creatora',
    discord_candidate_type: 'NATIVE_INVITE',
    discord_resolution_status: 'RESOLVED',
    discord_liveness_status: 'ACTIVE',
    discord_relevance_status: 'TRADING_RELEVANT',
    discord_validation_status: 'COMPLETED',
    community_discovery_status: 'NONE',
    community_intents: null,
    scan_status: 'COMPLETED',
    scan_attempts: 0,
    discovery_source: 'automated_query',
    first_seen: now,
    last_checked: now,
    subscriber_count: '1000',
    quality_score: 80,
    trading_status: 'TRADING_CONFIRMED',
    trading_confidence_score: 90,
    trading_category: 'Trading',
    country_metadata_status: 'AVAILABLE_NOT_DECLARED',
    country_metadata_checked_at: now,
    latest_upload_at: now,
    uploads_last_30_days: 1,
    uploads_last_90_days: 1,
    uploads_last_365_days: 1,
    activity_band: 'ACTIVE',
    activity_score: 80,
    activity_observed_at: now,
    inspection_trail: [],
  };

  const intents = extractCommunityIntentEvidence({
    pageUrl: 'https://www.whop.com/creator',
    html: '<h1>VIP Trading Membership</h1><p>Members only — $49/mo</p>',
  });
  assert.equal(intents.length, 1);
  assert.equal(intents[0].intent, 'PAID');

  // This is the same projection helper queueManager calls after the Discord
  // branch. It must leave every invite-derived field untouched.
  assert.equal(applyCommunityIntentEvidence(record, intents), true);
  assert.equal(record.discord_status, 'ACTIVE');
  assert.equal(record.discord_discovery_status, 'VALIDATED');
  assert.equal(record.discord_invite, 'https://discord.gg/creatora');
  assert.equal(record.community_discovery_status, 'PAID_COMMUNITY_INDICATED');

  await upsertChannel(record);

  const stored = await getChannelById(channelId);
  assert.ok(stored, 'channel is persisted');
  assert.equal(stored.discord_status, 'ACTIVE');
  assert.equal(stored.discord_discovery_status, 'VALIDATED');
  assert.equal(stored.discord_invite, 'https://discord.gg/creatora');
  assert.equal(stored.community_discovery_status, 'PAID_COMMUNITY_INDICATED');
  assert.equal(stored.community_intents?.[0]?.communityPlatform, 'WHOP');
  assert.equal(stored.community_intents?.[0]?.intent, 'PAID');
  assert.match(stored.community_intents?.[0]?.communityUrl || '', /whop\.com\/creator/);

  // /api/channels returns listChannelsPage() directly (server.ts). This is the
  // actual API payload projection, including the JSONB community intent.
  const api = await listChannelsPage({ limit: 10, offset: 0, search: channelName });
  const row = api.items.find(item => item.channel_id === channelId);
  assert.ok(row, 'channel is returned by the /api/channels listing projection');
  assert.equal(row.discord_status, 'ACTIVE');
  assert.equal(row.discord_discovery_status, 'VALIDATED');
  assert.equal(row.discord_invite, 'https://discord.gg/creatora');
  assert.equal(row.community_discovery_status, 'PAID_COMMUNITY_INDICATED');
  assert.equal(row.community_intents?.[0]?.communityPlatform, 'WHOP');
  assert.equal(row.community_intents?.[0]?.intent, 'PAID');
  assert.match(row.community_intents?.[0]?.communityUrl || '', /whop\.com\/creator/);
});
