import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldReactivateCommunityRecovery, reactivateCommunityRecovery } from './communityRecovery';
import type { ChannelRecord } from '../src/types';

const mockChannel = (scan_status = 'FAILED_PERMANENT', last_checked = '2026-01-01T00:00:00Z'): ChannelRecord => ({
  channel_id: 'UC_test_1',
  channel_name: 'Test Trader',
  youtube_url: 'https://youtube.com/channel/UC_test_1',
  country: 'Germany',
  country_status: 'CONFIRMED',
  confidence_score: 90,
  discord_status: 'NOT_FOUND',
  scan_status: scan_status as any,
  scan_attempts: 5,
  discovery_source: 'automated_query',
  first_seen: '2026-01-01T00:00:00Z',
  last_checked
});

test('FAILED_PERMANENT without triggers remains dormant', () => {
  const channel = mockChannel('FAILED_PERMANENT', '2026-08-15T00:00:00Z');
  const check = shouldReactivateCommunityRecovery(channel, undefined, false, Date.parse('2026-08-15T12:00:00Z'));

  assert.equal(check.reactivate, false);
  assert.ok(check.reasonCodes.includes('NO_REACTIVATION_TRIGGER_MATCHED'));
});

test('shouldReactivateCommunityRecovery reactivates FAILED_PERMANENT on newly observed links', () => {
  const channel = mockChannel();
  const check = shouldReactivateCommunityRecovery(channel, {
    channelId: 'UC_test_1',
    channelName: 'Test Trader',
    youtubeUrl: 'https://youtube.com/channel/UC_test_1',
    description: '',
    videoTitles: [],
    channelLinks: ['https://discord.gg/newlink']
  });

  assert.equal(check.reactivate, true);
  assert.ok(check.reasonCodes.includes('NEWLY_OBSERVED_EXTERNAL_LINKS'));
});

test('shouldReactivateCommunityRecovery reactivates FAILED_PERMANENT after freshness interval expires', () => {
  const channel = mockChannel('FAILED_PERMANENT', '2026-01-01T00:00:00Z');
  const check = shouldReactivateCommunityRecovery(channel, undefined, false, Date.parse('2026-03-01T00:00:00Z'));

  assert.equal(check.reactivate, true);
  assert.ok(check.reasonCodes.includes('COMMUNITY_FRESHNESS_INTERVAL_EXPIRED'));
});

test('reactivateCommunityRecovery resets scan_status to ENRICHMENT_PENDING while preserving history', () => {
  const channel = mockChannel();
  channel.inspection_trail = [{ step: 'BIO', title: 'Prior Failed Attempt', status: 'NOT_FOUND', timestamp: '2026-01-01T00:00:00Z' }];

  const reactivated = reactivateCommunityRecovery(channel, ['OPERATOR_NOMINATED_RECHECK']);

  assert.equal(reactivated.scan_status, 'ENRICHMENT_PENDING');
  assert.equal(reactivated.discord_status, 'UNCERTAIN');
  assert.equal(reactivated.inspection_trail.length, 2);
  assert.equal(reactivated.inspection_trail[0].title, 'Prior Failed Attempt');
  assert.ok(reactivated.inspection_trail[1].title.includes('Reactivated'));
});
