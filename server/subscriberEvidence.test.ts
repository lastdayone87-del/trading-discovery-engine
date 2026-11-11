import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  SUBSCRIBER_COUNT_MAX_AGE_DAYS,
  ensureSubscriberEvidence,
  isFreshSubscriberCount,
  applyChannelSubscriberEvidenceToCandidate,
  applySubscriberEvidenceToChannel,
} from './subscriberEvidence';
import { evaluateLowAudienceGate, parseSubscriberCountNumber } from './lowAudienceGate';
import type { DiscoveredChannelRaw } from './youtube';
import { writeChannelUpsert } from './dbCore';

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const nowMs = Date.parse('2026-11-11T12:00:00.000Z');
const nowIso = new Date(nowMs).toISOString();
const daysAgo = (days: number) => new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();

function candidate(overrides: Partial<DiscoveredChannelRaw> = {}): DiscoveredChannelRaw {
  return {
    channelId: 'UC1234567890123456789012',
    channelName: 'Example',
    youtubeUrl: 'https://www.youtube.com/channel/UC1234567890123456789012',
    description: '',
    videoTitles: [],
    channelLinks: [],
    ...overrides,
  };
}

test('subscriber evidence reuses counts inside the 30-day window and refreshes older ones', () => {
  assert.equal(SUBSCRIBER_COUNT_MAX_AGE_DAYS, 30);
  assert.equal(isFreshSubscriberCount('123', daysAgo(29), nowMs), true);
  assert.equal(isFreshSubscriberCount('123', daysAgo(30), nowMs), true);
  assert.equal(isFreshSubscriberCount('123', daysAgo(31), nowMs), false);
  assert.equal(isFreshSubscriberCount('123', undefined, nowMs), true, 'legacy count without a timestamp is trusted');
  assert.equal(isFreshSubscriberCount(undefined, nowIso, nowMs), false);
});

test('official hidden is terminal, not a failed fetch and not low-audience', async () => {
  let publicCalls = 0;
  const resolved = await ensureSubscriberEvidence(candidate(), {
    now: () => nowMs,
    fetchOfficial: async (_id, fallback) => ({ ...fallback, subscriberCountHidden: true, subscriberCountCheckedAt: nowIso }),
    fetchPublic: async () => { publicCalls += 1; return null; },
  });
  assert.equal(resolved.state, 'HIDDEN');
  assert.equal(resolved.candidate.subscriberCountHidden, true);
  assert.equal(publicCalls, 0, 'public About is not retried for an owner-hidden count');
  assert.equal(evaluateLowAudienceGate(undefined, 30, true).reasonCode, 'SUBSCRIBER_COUNT_HIDDEN');
  assert.equal(evaluateLowAudienceGate(undefined, 30, true).shouldSkipDeepEnrichment, false);
});

test('official success is reused without a public fetch', async () => {
  let publicCalls = 0;
  const resolved = await ensureSubscriberEvidence(candidate(), {
    now: () => nowMs,
    fetchOfficial: async (_id, fallback) => ({ ...fallback, subscriberCount: '1200', subscriberCountCheckedAt: nowIso }),
    fetchPublic: async () => { publicCalls += 1; return null; },
  });
  assert.equal(resolved.state, 'KNOWN');
  assert.equal(resolved.candidate.subscriberCount, '1200');
  assert.equal(publicCalls, 0);
});

test('public About fills a count when official metadata has none', async () => {
  const resolved = await ensureSubscriberEvidence(candidate(), {
    now: () => nowMs,
    fetchOfficial: async (_id, fallback) => ({ ...fallback, countryMetadataStatus: 'UNAVAILABLE', countryMetadataCheckedAt: nowIso }),
    fetchPublic: async () => ({ subscriberCountText: '3.4M subscribers', bio: 'bio' }),
  });
  assert.equal(resolved.state, 'KNOWN');
  assert.equal(parseSubscriberCountNumber(resolved.candidate.subscriberCount), 3_400_000);
});

test('both sources failing is FAILED, never unknown-pass', async () => {
  const resolved = await ensureSubscriberEvidence(candidate(), {
    now: () => nowMs,
    fetchOfficial: async () => { throw new Error('official unavailable'); },
    fetchPublic: async () => null,
  });
  assert.equal(resolved.state, 'FAILED');
  assert.equal(resolved.attempts, 2);
});

test('a failed refresh preserves an existing stale count as last-known-good', async () => {
  const old = daysAgo(45);
  const resolved = await ensureSubscriberEvidence(candidate({ subscriberCount: '48', subscriberCountCheckedAt: old }), {
    now: () => nowMs,
    fetchOfficial: async (_id, fallback) => fallback,
    fetchPublic: async () => null,
  });
  assert.equal(resolved.state, 'KNOWN');
  assert.equal(resolved.stale, true);
  assert.equal(resolved.candidate.subscriberCount, '48');
  assert.equal(resolved.candidate.subscriberCountCheckedAt, old);
});

test('channel evidence seeds the candidate and hidden is sticky', () => {
  const seeded = applyChannelSubscriberEvidenceToCandidate(candidate(), {
    subscriber_count: '29',
    subscriber_count_hidden: false,
    country_metadata_checked_at: daysAgo(2),
    public_about_checked_at: null,
    last_checked: null,
  });
  assert.equal(seeded.subscriberCount, '29');
  assert.equal(seeded.subscriberCountCheckedAt, daysAgo(2));

  const hidden = applyChannelSubscriberEvidenceToCandidate(candidate({ subscriberCount: '29' }), {
    subscriber_count: '29',
    subscriber_count_hidden: true,
    country_metadata_checked_at: daysAgo(2),
    public_about_checked_at: null,
    last_checked: null,
  });
  assert.equal(hidden.subscriberCountHidden, true);

  const channel = {
    channel_id: 'x', channel_name: 'x', youtube_url: 'x', country: '', country_status: 'UNCERTAIN',
    confidence_score: 0, discord_status: 'UNCERTAIN', discord_invite: null, scan_status: 'ENRICHMENT_PENDING',
    scan_attempts: 0, discovery_source: 'automated_query', first_seen: nowIso, subscriber_count: undefined,
    subscriber_count_hidden: false, trading_status: 'UNCERTAIN',
  } as any;
  applySubscriberEvidenceToChannel(channel, { subscriberCount: '1.2K', subscriberCountHidden: false });
  assert.equal(channel.subscriber_count, '1.2K');
  applySubscriberEvidenceToChannel(channel, { subscriberCountHidden: true });
  assert.equal(channel.subscriber_count_hidden, true);
});

test('subscriber parsing covers zero, commas, compact suffixes and malformed input', () => {
  assert.equal(parseSubscriberCountNumber('0'), 0);
  assert.equal(parseSubscriberCountNumber('1,234 subscribers'), 1234);
  assert.equal(parseSubscriberCountNumber('1.2K subscribers'), 1200);
  assert.equal(parseSubscriberCountNumber('3.4M'), 3_400_000);
  assert.equal(parseSubscriberCountNumber('29 subscribers'), 29);
  for (const raw of ['hidden', 'N/A', '@handle', '1..K', '.5K', '1.2', '', undefined]) {
    assert.equal(parseSubscriberCountNumber(raw), undefined, String(raw));
  }
});

test('admission resolves audience before provisional rows and job enqueue', () => {
  const queue = read('server/queueManager.ts');
  const admission = queue.indexOf('export async function admitDiscoveredChannel');
  const ensure = queue.indexOf('ensureSubscriberEvidence(raw', admission);
  const provisional = queue.indexOf('buildProvisionalClassificationChannel(raw', admission);
  assert.ok(admission >= 0 && ensure > admission && provisional > ensure);
  assert.match(queue.slice(admission, provisional), /audience\.state === 'FAILED'/);
  assert.match(queue.slice(admission, provisional), /persisted: Boolean\(existing\)/);
});

test('all channel write branches persist candidate count and hidden marker', () => {
  const pipeline = read('server/ingestionPipeline.ts');
  assert.match(pipeline, /function applyCandidateObservability[\s\S]*candidate\.subscriberCountHidden === true[\s\S]*channel\.subscriber_count = subscriberCount/);
  assert.match(pipeline, /const lowAudienceGate = evaluateLowAudienceGate\(candidate\.subscriberCount, 30, candidate\.subscriberCountHidden === true\)/);
  assert.match(read('server/classificationDecoupling.ts'), /subscriber_count_hidden: candidate\.subscriberCountHidden === true/);
  assert.match(read('server/dbCore.ts'), /subscriber_count_hidden=\(channels\.subscriber_count_hidden OR excluded\.subscriber_count_hidden\)/);
  assert.match(read('server/dbCore.ts'), /WHEN subscriber_count_hidden THEN NULL/);
  assert.ok(fs.existsSync(path.join(root, 'server/db/migrations/181_subscriber_count_hidden.sql')));
});

test('channel upsert writes the sticky hidden marker without breaking parameter order', async () => {
  let sql = '';
  let params: unknown[] = [];
  const client = {
    query: async (text: string, values?: unknown[]) => {
      sql = text;
      params = values || [];
      return { rowCount: 1 };
    },
  };
  const channel = {
    channel_id: 'UC1234567890123456789012', channel_name: 'Example',
    youtube_url: 'https://www.youtube.com/channel/UC1234567890123456789012',
    country: 'UNKNOWN', country_status: 'UNCERTAIN', confidence_score: 0,
    discord_status: 'UNCERTAIN', discord_invite: null,
    scan_status: 'CLASSIFICATION_PENDING', scan_attempts: 0,
    discovery_source: 'automated_query', first_seen: nowIso,
    last_checked: null, inspection_trail: [], subscriber_count: undefined,
    subscriber_count_hidden: true, channel_thumbnail_url: null,
    quality_score: 0, trading_status: 'UNCERTAIN', trading_confidence_score: 0,
    trading_category: 'General Trading',
  } as any;
  await writeChannelUpsert(client as never, channel);
  const placeholders = [...new Set([...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
  assert.deepEqual(placeholders, Array.from({length: 51}, (_, i) => i + 1));
  assert.equal(params.length, 51);
  assert.equal(params[49], true, 'hidden marker is persisted');
  assert.match(sql, /subscriber_count_hidden=\(channels\.subscriber_count_hidden OR excluded\.subscriber_count_hidden\)/);
});
