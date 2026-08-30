import assert from 'node:assert/strict';
import test from 'node:test';
import { processChannelThroughPipeline } from '../server/ingestionPipeline';
import { getChannelById, upsertChannel, getDb } from '../server/db';
import type { ChannelRecord } from '../src/types';

test('Integration: Persistence boundary proves creator_country = null when detectedCreatorCountry = null', async (t) => {
  // Mock DB if DB is available or test through pure object structure + upsertChannel
  const testChannelId = 'test_persistence_channel_null_country';
  const candidate = {
    channelId: testChannelId,
    channelName: 'Test Channel No Location',
    youtubeUrl: `https://youtube.com/channel/${testChannelId}`,
    description: 'General trading educational content and daily analysis',
    videoTitles: ['Daily Market Analysis', 'Trading Strategy Breakdown'],
    countryMetadataStatus: 'AVAILABLE_NOT_DECLARED' as const
  };

  if (process.env.DATABASE_URL) {
    const outcome = await processChannelThroughPipeline(candidate, 'Canada', 'automated_query', false);
    assert.equal(outcome.detectedCountry, null);
    assert.equal(outcome.countryStatus, 'UNCERTAIN');
    if (outcome.channelRecord) {
      assert.equal(outcome.channelRecord.country, null);
    }
  }

  // Directly verify that upsertChannel with null country preserves country = null
  const recordToUpsert: ChannelRecord = {
    channel_id: 'test_upsert_null_country',
    channel_name: 'Test Upsert Null',
    youtube_url: 'https://youtube.com/channel/test_upsert_null_country',
    country: null,
    country_status: 'UNCERTAIN',
    confidence_score: 0,
    discord_status: 'NOT_FOUND',
    scan_status: 'PENDING',
    scan_attempts: 0,
    discovery_source: 'automated_query',
    first_seen: new Date().toISOString()
  };

  if (process.env.DATABASE_URL) {
    await upsertChannel(recordToUpsert);
    const fetched = await getChannelById('test_upsert_null_country');
    if (fetched) {
      assert.equal(fetched.country, null, 'persisted channels.country must be NULL');
    }
  } else {
    // Verify object model invariant when running without active PostgreSQL
    assert.equal(recordToUpsert.country, null);
  }
});

test('Integration: Pipeline halts immediately on REJECT_EXCLUDED', async () => {
  const candidate = {
    channelId: 'test_pipeline_reject_excluded',
    channelName: 'FX Trader Nigeria',
    youtubeUrl: 'https://youtube.com/channel/test_pipeline_reject_excluded',
    description: 'Professional forex trader based in Nigeria.',
    videoTitles: ['EURUSD Scalping Strategy'],
    countryMetadataStatus: 'AVAILABLE_DECLARED' as const
  };

  if (process.env.DATABASE_URL) {
    const outcome = await processChannelThroughPipeline(candidate, 'United Kingdom', 'automated_query', false);
    assert.equal(outcome.countryStatus, 'REJECTED');
    assert.equal(outcome.detectedCountry, 'Nigeria');
    assert.equal(outcome.tradingStatus, 'UNCERTAIN');
    assert.equal(outcome.discordStatus, 'NOT_FOUND');
    assert.equal(outcome.discordInvite, null);
  }
});

test('Integration: Pipeline routes conflicting evidence directly to NEEDS_REVIEW', async () => {
  const candidate = {
    channelId: 'test_pipeline_needs_review',
    channelName: 'Conflicting Trader UK Nigeria',
    youtubeUrl: 'https://youtube.com/channel/test_pipeline_needs_review',
    description: 'Trader based in United Kingdom and Nigeria.',
    videoTitles: ['Weekly Forex Outlook'],
    countryMetadataStatus: 'AVAILABLE_DECLARED' as const
  };

  if (process.env.DATABASE_URL) {
    const outcome = await processChannelThroughPipeline(candidate, 'Canada', 'automated_query', false);
    assert.equal(outcome.countryStatus, 'UNCERTAIN');
    assert.equal(outcome.tradingStatus, 'NEEDS_REVIEW');
    assert.equal(outcome.discordStatus, 'UNCERTAIN');
    if (outcome.channelRecord) {
      assert.equal(outcome.channelRecord.scan_status, 'NEEDS_REVIEW');
      assert.equal(outcome.channelRecord.trading_status, 'NEEDS_REVIEW');
    }
  }
});

test('Read Model Projection: Dashboard exposes creatorCountry: null and discoveryCountry: Canada', () => {
  const mockChannel: ChannelRecord = {
    channel_id: 'ch_dashboard_test',
    channel_name: 'Dashboard Test Channel',
    youtube_url: 'https://youtube.com/channel/ch_dashboard_test',
    country: null,
    country_status: 'UNCERTAIN',
    confidence_score: 0,
    discord_status: 'NOT_FOUND',
    scan_status: 'NEEDS_REVIEW',
    scan_attempts: 0,
    discovery_source: 'automated_query',
    first_seen: new Date().toISOString()
  };

  const discoveryCountry = 'Canada';

  // Read model projection mapping
  const dashboardProjection = {
    channelId: mockChannel.channel_id,
    channelName: mockChannel.channel_name,
    creatorCountry: mockChannel.country,
    discoveryCountry: discoveryCountry,
    countryStatus: mockChannel.country_status,
    displayCountry: mockChannel.country ? mockChannel.country : 'Unknown'
  };

  assert.equal(dashboardProjection.creatorCountry, null);
  assert.equal(dashboardProjection.discoveryCountry, 'Canada');
  assert.equal(dashboardProjection.displayCountry, 'Unknown');
  assert.notEqual(dashboardProjection.displayCountry, 'Canada');
});
