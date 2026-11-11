import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMUNITY_CAPACITY_RETRY_LEASE_MS,
  reconcileCommunityAcquisitionRecovery
} from './communityRecovery';
import { ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV } from './acquisitionJobClockPolicy';

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
            capacity_terminal: true,
            retry_reason: 'BROWSER_RUNTIME_UNAVAILABLE'
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
  const enqueued: Array<{ channelId: string; reasons?: string; retryReason?: string }> = [];
  const now = Date.now() + 120_000;

  const recovered = await reconcileCommunityAcquisitionRecovery(
    async () => db,
    async id => id === channel.channel_id ? channel : null,
    async updated => { upserts.push(updated); },
    20,
    now,
    async (channelId, reasons, retryReason) => { enqueued.push({ channelId, reasons, retryReason }); }
  );

  assert.equal(recovered, 1);
  assert.deepEqual(enqueued.map(item => item.channelId), ['UC_CAPACITY_ONLY']);
  assert.match(enqueued[0].reasons || '', /ATTEMPT_FREE_CAPACITY_RETRY_REOPENED/);
  assert.equal(enqueued[0].retryReason, 'BROWSER_RUNTIME_UNAVAILABLE', 'browser-runtime attribution survives capacity recovery');
  const selection = queries.find(query => query.sql.includes('SELECT c.channel_id'))?.sql || '';
  assert.match(selection, /retry_job\.retry_reason/, 'the outer query must project the lateral retry reason');
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

test('a blocked reopen restores the channel projection and does not count as recovered', async () => {
  const db = {
    async query(sql: string) {
      if (sql.includes('SELECT c.channel_id')) {
        return {
          rows: [{
            channel_id: 'UC_CAPACITY_BLOCKED',
            capacity_retry_job_id: 'job-capacity-blocked',
            capacity_terminal: true,
            retry_reason: 'BROWSER_RUNTIME_UNAVAILABLE',
            reopen_generation: 6
          }]
        };
      }
      return { rows: [], rowCount: 1 };
    }
  };

  const lastChecked = '2026-11-05T00:00:00.000Z';
  const channel: any = {
    channel_id: 'UC_CAPACITY_BLOCKED',
    channel_name: 'Capacity Blocked',
    youtube_url: 'https://youtube.com/channel/UC_CAPACITY_BLOCKED',
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
    last_checked: lastChecked,
    inspection_trail: [],
    trading_status: 'TRADING_CONFIRMED',
    trading_confidence_score: 100,
    trading_category: 'General Trading',
    activity_band: 'UNKNOWN',
    activity_score: 50
  };

  const upserts: any[] = [];
  const recovered = await reconcileCommunityAcquisitionRecovery(
    async () => db,
    async id => id === channel.channel_id ? channel : null,
    async updated => { upserts.push(updated); },
    20,
    Date.now() + 180_000,
    async () => false
  );

  assert.equal(recovered, 0, 'a blocked reopen must not count as a recovered channel');
  assert.equal(upserts.length, 2, 'the reactivated projection must be rolled back');
  assert.equal(upserts[1].scan_status, 'FAILED');
  assert.equal(upserts[1].last_checked, lastChecked);
  assert.equal(upserts[1].discord_validation_status, 'RETRY_PENDING');
});

test('clock-v2 capacity recovery renews leases without rewriting queue or failure clocks', async () => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  try {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const db = {
      async query(sql: string, values?: unknown[]) {
        queries.push({ sql, values });
        if (sql.includes('SELECT c.channel_id')) {
          return {
            rows: [{
              channel_id: 'UC_CAPACITY_ONLY',
              capacity_retry_job_id: 'job-capacity-only',
              capacity_terminal: true,
              retry_reason: 'BROWSER_RUNTIME_UNAVAILABLE'
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

    await reconcileCommunityAcquisitionRecovery(
      async () => db,
      async id => id === channel.channel_id ? channel : null,
      async () => undefined,
      20,
      Date.now() + 240_000,
      async () => undefined
    );

    assert.equal(
      queries.filter(query => /created_at\s*=\s*now\(\)/.test(query.sql)).length,
      0,
      'clock-v2 reconciliation must never rewrite the queue clock'
    );

    const communityRefresh = queries.find(query =>
      query.sql.includes("type='RETRY_COMMUNITY_ACQUISITION'")
      && query.sql.includes("status IN('PENDING','PROCESSING')")
    );
    assert.ok(communityRefresh, 'active capacity deferrals should renew their lease');
    assert.match(communityRefresh!.sql, /capacity_lease_expires_at=/);
    assert.match(communityRefresh!.sql, /capacity_lease_renewals=/);
    assert.doesNotMatch(communityRefresh!.sql, /first_transient_failure_at/);
    assert.equal(communityRefresh!.values?.[1], String(COMMUNITY_CAPACITY_RETRY_LEASE_MS));

    const terminalEpochRefresh = queries.find(query => query.sql.includes("WHERE id=$1 AND status='FAILED'"));
    assert.ok(terminalEpochRefresh, 'terminal capacity-only retry should renew its lease before reopen');
    assert.match(terminalEpochRefresh!.sql, /capacity_lease_started_at=/);
    assert.doesNotMatch(terminalEpochRefresh!.sql, /created_at/);
    assert.deepEqual(terminalEpochRefresh!.values, ['job-capacity-only', String(COMMUNITY_CAPACITY_RETRY_LEASE_MS)]);

    const selection = queries.find(query => query.sql.includes('SELECT c.channel_id'))?.sql || '';
    assert.match(selection, /ORDER BY COALESCE\(j\.last_reopened_at, j\.created_at\) DESC/);
    assert.match(
      selection,
      /COALESCE\(c\.scope_eligibility,''\) <> 'OUT_OF_SCOPE'/,
      'automatic recovery must skip channels ruled out of scope',
    );
  } finally {
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
  }
});
