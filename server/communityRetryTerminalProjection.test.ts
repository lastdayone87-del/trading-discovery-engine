import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectTerminalCommunityRetryFailure } from './communityRecovery';

const base = {
  channel_id: 'UC-test', channel_name: 'Test', youtube_url: 'https://youtube.com/c/test',
  country: 'Belgium', country_status: 'CONFIRMED', confidence_score: 90,
  discord_status: 'UNCERTAIN', discord_invite: null, scan_status: 'FAILED', scan_attempts: 1,
  discovery_source: 'automated_query', first_seen: '2026-01-01T00:00:00.000Z', last_checked: null,
  trading_status: 'TRADING_CONFIRMED', trading_confidence_score: 96
} as any;

test('terminal retry failure is projected as operational failure, not retry-pending', () => {
  const result = projectTerminalCommunityRetryFailure({ ...base, discord_validation_status: 'RETRY_PENDING' }, 5, '2026-08-24T12:00:00.000Z');
  assert.equal(result.scan_status, 'FAILED');
  assert.equal(result.discord_validation_status, 'FAILED_OPERATIONAL');
  assert.equal(result.scan_attempts, 5);
  assert.equal(result.last_checked, '2026-08-24T12:00:00.000Z');
});

test('terminal retry projection preserves semantic completed or succeeded validation', () => {
  for (const status of ['COMPLETED', 'SUCCEEDED']) {
    const result = projectTerminalCommunityRetryFailure({ ...base, discord_validation_status: status }, 5);
    assert.equal(result.discord_validation_status, status);
  }
});

test('terminal retry projection preserves FAILED_PERMANENT scan state', () => {
  const result = projectTerminalCommunityRetryFailure({ ...base, scan_status: 'FAILED_PERMANENT', discord_validation_status: 'RETRY_PENDING' }, 5);
  assert.equal(result.scan_status, 'FAILED_PERMANENT');
  assert.equal(result.discord_validation_status, 'FAILED_OPERATIONAL');
});

test('worker uses the generic terminal retry projection helper', () => {
  const source = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(source, /projectTerminalCommunityRetryFailure\(channel,job\.attempts/);
  assert.doesNotMatch(source, /channel\.discord_validation_status='RETRY_PENDING';channel\.scan_attempts/);
});
