import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { classifyLegacyCommunityRetryDisposition, reconcileCommunityAcquisitionRecovery, reconcileLegacyCommunityRetryOwnership, shouldReactivateCommunityRecovery, reactivateCommunityRecovery } from './communityRecovery';
import type { ChannelRecord } from '../src/types';

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

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

test('active-creator recovery does not reopen immediately after a recent terminal failure', () => {
  const channel = Object.assign(mockChannel('FAILED', '2026-08-23T08:30:00Z'), {
    activity_band: 'VERY_ACTIVE',
    discord_validation_status: 'RETRY_PENDING'
  });
  const check = shouldReactivateCommunityRecovery(channel, undefined, false, Date.parse('2026-08-23T12:00:00Z'));
  assert.equal(check.reactivate, false);
  assert.deepEqual(check.reasonCodes, ['NO_REACTIVATION_TRIGGER_MATCHED']);
});

test('active-creator recovery reopens after the durable cooldown', () => {
  const channel = Object.assign(mockChannel('FAILED', '2026-08-22T11:00:00Z'), {
    activity_band: 'VERY_ACTIVE',
    discord_validation_status: 'RETRY_PENDING'
  });
  const check = shouldReactivateCommunityRecovery(channel, undefined, false, Date.parse('2026-08-23T12:00:00Z'));
  assert.equal(check.reactivate, true);
  assert.ok(check.reasonCodes.includes('HIGH_CREATOR_ACTIVITY'));
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

test('semantic terminal channel states are never resurrected by operational recovery',()=>{
  for (const overrides of [
    { country_status: 'REJECTED' },
    { trading_status: 'NON_TRADING' },
    { trading_status: 'HUMAN_REJECTED' }
  ]) {
    const channel = Object.assign(mockChannel('FAILED_PERMANENT', '2026-01-01T00:00:00Z'), overrides);
    const check = shouldReactivateCommunityRecovery(channel, undefined, false, Date.parse('2026-03-01T00:00:00Z'));
    assert.equal(check.reactivate, false);
    assert.equal(check.reasonCodes[0], 'SEMANTIC_TERMINAL_STATE_PRESERVED');
  }
});

test('legacy semantic terminal evidence is not resurrected',()=>{
  const channel=mockChannel('FAILED_PERMANENT','2026-01-01T00:00:00Z');
  channel.discord_validation_status='COMPLETED';
  const check=shouldReactivateCommunityRecovery(channel,undefined,true,Date.parse('2026-03-01T00:00:00Z'));
  assert.equal(check.reactivate,false);
  assert.deepEqual(check.reasonCodes,['SEMANTIC_TERMINAL_EVIDENCE_PRESERVED']);
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

test('automatic reconciliation reopens one governed retry window for an active creator and preserves job ownership rules', async () => {
  const channel = Object.assign(mockChannel('FAILED_PERMANENT', '2026-08-15T00:00:00Z'), {
    activity_band: 'VERY_ACTIVE',
    discord_validation_status: 'RETRY_PENDING'
  });
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const enqueued: string[] = [];
  const events: string[] = [];
  const persisted: ChannelRecord[] = [];
  const count = await reconcileCommunityAcquisitionRecovery(
    async () => ({
      query: async (sql: string, values: unknown[]) => {
        queries.push({ sql, values });
        return { rows: [{ channel_id: channel.channel_id }] };
      }
    }),
    async () => channel,
    async (updated: ChannelRecord) => { persisted.push(updated); events.push(`persist:${updated.scan_status}`); },
    1,
    Date.parse('2026-08-23T09:00:00Z'),
    async (channelId: string) => { enqueued.push(channelId); events.push(`enqueue:${channelId}`); }
  );

  assert.equal(count, 1);
  assert.deepEqual(enqueued, [channel.channel_id]);
  assert.deepEqual(events, ['persist:ENRICHMENT_PENDING', `enqueue:${channel.channel_id}`]);
  assert.equal(persisted[0].scan_status, 'ENRICHMENT_PENDING');
  assert.equal(persisted[0].discord_validation_status, 'RETRY_PENDING');
  assert.equal(persisted[0].trading_status, undefined);
  const recoverySelection=queries.find(query=>query.sql.includes("activity_band IN('ACTIVE','VERY_ACTIVE')"))?.sql || '';
  assert.match(recoverySelection, /activity_band IN\('ACTIVE','VERY_ACTIVE'\)/);
  assert.match(recoverySelection, /last_checked < now\(\) - interval '24 hours'/);
  assert.match(recoverySelection, /NOT EXISTS/);
  assert.match(recoverySelection, /status IN\('PENDING','PROCESSING'\)/);
});

test('legacy upstream retry closes as historical completed negative while genuine community failure remains retry-owned', () => {
  const upstream = classifyLegacyCommunityRetryDisposition({
    payload: { retryReason: 'UPSTREAM_REQUIRED_ACQUISITION_FAILURE' },
    inspectionTrail: [{ step: 'VIDEO_DESCRIPTIONS', status: 'SKIPPED' }],
    hasCurrentCommunityFailure: false,
    hasCurrentUpstreamRetryableFailure: true
  });
  assert.equal(upstream.disposition, 'COMPLETED_NEGATIVE');
  assert.equal(upstream.retryReason, 'NO_SURFACE');

  const community = classifyLegacyCommunityRetryDisposition({
    payload: { retryReason: 'UPSTREAM_REQUIRED_ACQUISITION_FAILURE' },
    inspectionTrail: [{ step: 'LINKED_WEBSITES', status: 'ERROR' }],
    hasCurrentCommunityFailure: true,
    hasCurrentUpstreamRetryableFailure: false
  });
  assert.equal(community.disposition, 'ACTIVE_COMMUNITY_RETRY');
  assert.equal(community.retryReason, 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');

  const browser = classifyLegacyCommunityRetryDisposition({
    payload: { retryReason: 'BROWSER_RUNTIME_UNAVAILABLE' },
    inspectionTrail: [{ step: 'VIDEO_DESCRIPTIONS', status: 'ERROR' }],
    hasCurrentCommunityFailure: false,
    hasCurrentUpstreamRetryableFailure: false
  });
  assert.equal(browser.disposition, 'ACTIVE_COMMUNITY_RETRY');
  assert.equal(browser.retryReason, 'BROWSER_RUNTIME_UNAVAILABLE');
});

test('non-retryable required community failure still preserves retry ownership (never a false completed negative)', () => {
  // A terminal acquisition failure (pure target block, unsupported preview
  // content) proves coverage is incomplete. The legacy reconciler must keep
  // the retry owned rather than projecting COMPLETED_NEGATIVE over it — an
  // inaccessible site is not a confirmed absence.
  const decision = classifyLegacyCommunityRetryDisposition({
    payload: { retryReason: 'UPSTREAM_REQUIRED_ACQUISITION_FAILURE' },
    inspectionTrail: [{ step: 'CUSTOM_DOMAINS', status: 'ERROR' }],
    hasCurrentCommunityFailure: true,
    hasCurrentUpstreamRetryableFailure: false
  });
  assert.equal(decision.disposition, 'ACTIVE_COMMUNITY_RETRY');
  assert.equal(decision.retryReason, 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
});

test('completed negative legacy retry is reclassified without deleting its audit job', () => {
  const decision = classifyLegacyCommunityRetryDisposition({
    payload: { retryReason: 'UPSTREAM_REQUIRED_ACQUISITION_FAILURE' },
    inspectionTrail: [
      { step: 'CHANNEL_LINKS', status: 'NOT_FOUND' },
      { step: 'LINKED_WEBSITES', status: 'NOT_FOUND' },
      { step: 'SOCIAL_PROFILES', status: 'SKIPPED' }
    ],
    hasCurrentCommunityFailure: false,
    hasCurrentUpstreamRetryableFailure: false
  });
  assert.equal(decision.disposition, 'COMPLETED_NEGATIVE');
  assert.equal(decision.retryReason, 'NO_SURFACE');
});

test('legacy completed-negative retry is completed as audit history without stale lifecycle markers', async () => {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const summary = await reconcileLegacyCommunityRetryOwnership(
    async () => ({
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes('SELECT j.id')) return {
          rows: [{
            id: 'retry-1',
            status: 'PENDING',
            payload: { channelId: 'UC_test_1', retryReason: 'UPSTREAM_REQUIRED_ACQUISITION_FAILURE' },
            channel_id: 'UC_test_1',
            created_at: '2026-08-25T10:00:00.000Z',
            inspection_trail: [
              { step: 'CHANNEL_EXTERNAL_LINKS', status: 'NOT_FOUND' },
              { step: 'CREATOR_WEBSITES', status: 'SKIPPED' },
              { step: 'SOCIAL_PROFILES', status: 'SKIPPED' }
            ],
            has_current_community_failure: false,
            has_current_upstream_retryable_failure: true
          }]
        };
        return { rows: [] };
      }
    }),
    100,
    '2026-08-25T12:00:00.000Z'
  );
  assert.equal(summary.closedNonCommunity, 1);
  assert.equal(summary.completedNegative, 1);
  assert.match(queries.map(item => item.sql).join('\n'), /SET status='COMPLETED'/);
  assert.match(queries.map(item => item.sql).join('\n'), /discord_status='NOT_FOUND',discord_validation_status='COMPLETED'/);
  assert.match(queries.map(item => item.sql).join('\n'), /discord_resolution_status='NOT_ATTEMPTED'/);
  assert.match(queries.map(item => item.sql).join('\n'), /discord_discovery_status='NOT_DISCOVERED'/);
  assert.match(queries.map(item => item.sql).join('\n'), /COALESCE\(discord_candidate_locator,''\)=''/);
  assert.match(queries.map(item => item.sql).join('\n'), /UPDATE job_attempts/);
  assert.doesNotMatch(queries.map(item => item.sql).join('\n'), /RECONCILIATION_REQUIRED|STALE_RETRY/);
});

test('legacy selector treats missing or malformed lifecycle versions as legacy and only explicitly current versioned jobs are excluded', () => {
  const source = read('server/communityRecovery.ts');
  assert.match(source, /CASE[\s\S]*btrim\(COALESCE\(j\.payload->>'retryLifecycleVersion',''\)\) ~ '\^\[0-9\]\+\$'/);
  assert.match(source, /THEN btrim\(j\.payload->>'retryLifecycleVersion'\)::numeric/);
  assert.match(source, /ELSE 0[\s\S]*END < 2/);
  assert.match(source, /j\.status IN\('PENDING','COMPLETED'\)/);
  assert.match(source, /c\.discord_status='NOT_FOUND' AND c\.discord_validation_status='RETRY_PENDING'/);
  assert.match(source, /c\.discord_status='UNCERTAIN' AND c\.scan_status='FAILED' AND c\.discord_validation_status='NOT_STARTED'/);
  assert.match(source, /COALESCE\(j\.payload->>'retryReason',''\) <> 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE'/);
  assert.match(source, /SET status='COMPLETED'/);
  assert.doesNotMatch(source, /reconciliationStatus: 'RECONCILIATION_REQUIRED'/);
});

test('reconciliation uses effective surface precedence so completed no-match coverage clears stale failure eligibility', () => {
  const source = read('server/communityRecovery.ts');
  assert.match(source, /SELECT DISTINCT ON \(o\.provenance->>'surface'/);
  assert.doesNotMatch(source, /o\.surface/);
  assert.match(source, /o\.provenance->>'surface' AS surface/);
  assert.match(source, /rtrim\(COALESCE\(o\.requested_url/);
  assert.match(source, /WHEN 'INSPECTED_NO_MATCH' THEN 2/);
  assert.match(source, /WHEN 'PARTIALLY_INSPECTED' THEN 1/);
  assert.match(source, /AND effective\.outcome='ACQUISITION_FAILED'/);
  assert.match(source, /effective\.surface IN\('CHANNEL_EXTERNAL_LINKS','CREATOR_WEBSITES','SOCIAL_PROFILES'/);
  assert.doesNotMatch(source, /DELETE FROM external_acquisition_observations/);
});



test('automatic reconciliation restores the prior failure projection when recovery-job reopening fails', async () => {
  const channel = Object.assign(mockChannel('FAILED', '2026-08-15T00:00:00Z'), { activity_band: 'ACTIVE', discord_validation_status: 'RETRY_PENDING' });
  const persisted: ChannelRecord[] = [];
  await assert.rejects(
    reconcileCommunityAcquisitionRecovery(
      async () => ({ query: async () => ({ rows: [{ channel_id: channel.channel_id }] }) }),
      async () => channel,
      async (updated: ChannelRecord) => { persisted.push(updated); },
      1,
      Date.parse('2026-08-23T09:01:00Z'),
      async () => { throw new Error('recovery enqueue unavailable'); }
    ),
    /recovery enqueue unavailable/
  );
  assert.deepEqual(persisted.map(item => item.scan_status), ['ENRICHMENT_PENDING', 'FAILED']);
  assert.equal(persisted[1].trading_status, channel.trading_status);
});

test('production ingestion and manual recheck entry points invoke community recovery reactivation', () => {
  const pipeSource = read('server/ingestionPipeline.ts');
  const queueSource = read('server/queueManager.ts');

  assert.match(pipeSource, /shouldReactivateCommunityRecovery\(existing, candidate, isManualScan\)/);
  assert.match(queueSource, /shouldReactivateCommunityRecovery\(channel, undefined, true\)/);
  assert.match(queueSource, /reconcileCommunityAcquisitionRecovery\(getDb, getChannelById, upsertChannel, 20, Date\.now\(\),/);
  assert.match(queueSource, /reconcileLegacyCommunityRetryOwnership\(getDb, 250\)/);
  assert.doesNotMatch(queueSource, /reconcilePendingCommunityRetryJobs\(getDb, 100\)/);
});
