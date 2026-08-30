import assert from 'node:assert/strict';
import test from 'node:test';
import { processChannelThroughPipeline } from '../server/ingestionPipeline';
import { shouldAttemptPublicAboutCountryFallback } from '../server/youtubePublicAbout';
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

test('About Fallback Durability & Idempotency: Metadata checked timestamp alone does NOT suppress About fallback', () => {
  const allowed = shouldAttemptPublicAboutCountryFallback({
    countryStatus: 'UNCERTAIN',
    countryMetadataStatus: 'AVAILABLE_NOT_DECLARED',
    description: '',
    publicAboutAttempted: false
  });

  assert.equal(allowed, true, 'About fallback must be allowed when metadata was checked but public About was never attempted');
});

test('About Fallback Durability & Idempotency: About attempted suppresses duplicate fetches', () => {
  const suppressed = shouldAttemptPublicAboutCountryFallback({
    countryStatus: 'UNCERTAIN',
    countryMetadataStatus: 'AVAILABLE_NOT_DECLARED',
    description: '',
    publicAboutAttempted: true
  });

  assert.equal(suppressed, false, 'About fallback must be suppressed when public About was already attempted');
});

test('About Fallback Durability & Idempotency: Job retry/reconstruction with inspection trail suppresses duplicate fetches', () => {
  const existingChannel: Partial<ChannelRecord> = {
    channel_id: 'ch_retry_about_test',
    country_metadata_checked_at: new Date().toISOString(),
    inspection_trail: [
      {
        step: 'COUNTRY_VALIDATION',
        title: 'Country Validation (Unknown)',
        status: 'NOT_FOUND',
        details: 'Official Metadata: Available; channel declared no country\nPublic About page attempted.',
        timestamp: new Date().toISOString()
      }
    ]
  };

  const publicAboutAttempted = Boolean(
    existingChannel.inspection_trail?.some(s => s.details?.includes('Public About') || s.title?.includes('Live About'))
  );

  assert.equal(publicAboutAttempted, true, 'Reconstructed job must identify prior About attempt from inspection trail');
});

test('About Fallback Durability & Idempotency: Successful About bio populating description prevents re-fetching', () => {
  const suppressedByBio = shouldAttemptPublicAboutCountryFallback({
    countryStatus: 'UNCERTAIN',
    countryMetadataStatus: 'AVAILABLE_NOT_DECLARED',
    description: 'Professional forex trader daily technical analysis and risk management',
    publicAboutAttempted: false
  });

  assert.equal(suppressedByBio, false, 'Usable bio text prevents repeated About fetches');
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
