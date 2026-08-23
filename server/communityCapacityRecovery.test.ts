import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMUNITY_CAPACITY_RETRY_LEASE_MS,
  reconcileCommunityAcquisitionRecovery
} from './communityRecovery';

test('capacity-only terminal community retry is reopened immediately and its retry epoch is renewed', async () => {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const db = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes('SELECT c.channel_id')) {
        return {
          rows: [{
            channel_id: 'UC_CAPACITY_ONLY',
            capacity_retry_job_id: 'job-capacity-only',
            capacity_terminal: true
          }]
        };
      }
      return { rows: [], rowCount: 1 };
    }
  };

  const channel: any = {
    channel_id: 'UC_CAPACITY_ONLY',
    channel_name: 'Capacity Only',
    youtube_url: 'https://youtube.com/channel/UC_CAPACITY_ONLY',
    country: 'Germany',
    country_status: 'CONFIRMED',
    confidence_score: 100,
    discord_status: 'UNCERTAIN',
    discord_invite: null,
    discord_validation_status: 'RETRY_PENDING',
    scan_status: 'FAILED',
    scan_attempts: 1,
    discovery_source: 'autonomous',
    first_seen: new Date(0).toISOString(),
    last_checked: new Date().toISOString(),
    inspection_trail: [],
    trading_status: 'TRADING_CONFIRMED',
    trading_confidence_score: 100,
    trading_category: 'General Trading',
    activity_band: 'UNKNOWN',
    activity_score: 50
  };

  const upserts: any[] = [];
  const enqueued: string[] = [];
  const now = Date.now() + 120_000;

  const recovered = await reconcileCommunityAcquisitionRecovery(
    async () => db,
    async id => id === channel.channel_id ? channel : null,
    async updated => { upserts.push(updated); },
    20,
    now,
    async channelId => { enqueued.push(channelId); }
  );

  assert.equal(recovered, 1);
  assert.deepEqual(enqueued, ['UC_CAPACITY_ONLY']);
  assert.equal(upserts[0].scan_status, 'ENRICHMENT_PENDING');
  assert.equal(upserts[0].discord_validation_status, 'RETRY_PENDING');
  assert.match(upserts[0].inspection_trail.at(-1).details, /ATTEMPT_FREE_CAPACITY_RETRY_REOPENED/);

  const activeLeaseRefresh = queries.find(q => q.sql.includes("status IN('PENDING','PROCESSING')"));
  assert.ok(activeLeaseRefresh, 'active capacity-deferred retries should renew before the generic age ceiling');
  assert.equal(activeLeaseRefresh?.values?.[1], String(COMMUNITY_CAPACITY_RETRY_LEASE_MS));

  const terminalEpochRefresh = queries.find(q => q.sql.includes("WHERE id=$1 AND status='FAILED'"));
  assert.ok(terminalEpochRefresh, 'terminal capacity-only retry should receive a fresh retry epoch before enqueue');
  assert.deepEqual(terminalEpochRefresh?.values, ['job-capacity-only']);
});
