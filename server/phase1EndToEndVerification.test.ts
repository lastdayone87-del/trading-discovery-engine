import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChannelRecord } from '../src/types';
import { canonicalDiscordInviteId, mergeDiscordCandidates } from './discordCandidates';
import { projectDiscordValidation } from './discordProjection';
import { validateDiscordInvite } from './discordValidator';
import { detectPendingDiscoveryWork, projectNotFoundAfterInspection } from './queueManager';
import type { AcquisitionSurface } from './inspector';
import { runChannelInspectionForTest as runChannelInspection } from './testCrawlHelpers';

// M1 is a deterministic static-acquisition suite. Remove any configured DB URL
// for this test process so getDb() cannot migrate or seed a developer database;
// settings reads fail closed to defaults and no DB writes occur.
delete process.env.DATABASE_URL;

const DESCRIPTIONS = ['one', 'two', 'three', 'four', 'five'];

const html = (body: string, status = 200) =>
  new Response(`<html><body>${body}</body></html>`, { status, headers: { 'content-type': 'text/html' } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function blankChannel(): ChannelRecord {
  return {
    channel_id: 'UCe2e0000000000000000001',
    channel_name: 'E2E Test Creator',
    discord_status: 'PENDING',
    discord_invite: null,
    discord_candidate_locator: null,
    discord_candidate_id: null,
    discord_candidate_raw_locator: null,
    discord_candidate_type: null,
    discord_resolution_status: 'NOT_ATTEMPTED',
    discord_liveness_status: 'NOT_CHECKED',
    discord_relevance_status: 'NOT_CHECKED',
    discord_validation_status: 'NOT_STARTED',
    discord_discovery_status: 'NOT_DISCOVERED',
    scan_status: 'LOCKED',
    scan_attempts: 0,
  } as unknown as ChannelRecord;
}

async function validateAndProject(code: string, candidate: Parameters<typeof projectDiscordValidation>[2]) {
  const validation = await validateDiscordInvite(code, {
    maxAttempts: 1,
    retryDelayMs: 0,
    channelName: 'E2E Test Creator',
    parentChannelIsTrading: true,
    emitProviderEvent: async () => {},
    fetchImpl: (async (input: any) => {
      const url = String(input);
      if (url.includes('/invites/')) {
        return json({
          code,
          approximate_member_count: 100,
          approximate_presence_count: 10,
          guild: {
            id: 'guild-e2e',
            name: 'Futures Trading Community',
            description: '',
            features: [],
          },
          channel: { name: 'trading-floor' },
        });
      }
      throw new Error(`unexpected Discord validation fetch: ${url}`);
    }) as typeof fetch,
  });
  assert.equal(validation.validationStatus, 'SUCCEEDED');
  assert.equal(validation.livenessStatus, 'ACTIVE');
  const projected = projectDiscordValidation(blankChannel(), validation, candidate);
  assert.equal(projected.discord_status, 'ACTIVE');
  assert.equal(projected.discord_invite, `https://discord.gg/${code}`);
  assert.equal(projected.discord_validation_status, 'SUCCEEDED');
  assert.equal(projected.discord_discovery_status, 'VALIDATED');
  return { validation, projected };
}

async function expectFound(
  input: Parameters<typeof runChannelInspection>[0],
  code: string,
  expectedSurfaces: AcquisitionSurface[],
) {
  const result = await runChannelInspection({...input, creatorLikelyTrading: false, urlFailureHistoryLoader: async () => []});
  assert.equal(result.foundInvite, code);
  assert.equal(result.acquisitionStatus, 'FOUND');
  assert.ok(result.discordCandidates?.length, 'inspection must retain a structured candidate');

  const merged = mergeDiscordCandidates(result.discordCandidates || [], {
    creatorName: 'E2E Test Creator',
    creatorWebsiteHosts: ['creator.example'],
  });
  assert.equal(merged.length, 1, 'one canonical invite survives deduplication');
  const candidate = merged[0]!;
  assert.equal(candidate.canonicalInviteId, canonicalDiscordInviteId(code));
  assert.equal(candidate.nativeInviteCode, code);
  const surfaces = new Set(candidate.observations?.map(observation => observation.sourceSurface));
  for (const surface of expectedSurfaces) {
    assert.ok(surfaces.has(surface), `candidate provenance includes ${surface}`);
  }

  const { validation, projected } = await validateAndProject(code, candidate);
  assert.equal(validation.inviteUrl, `https://discord.gg/${code}`);
  assert.equal(projected.discord_candidate_id, candidate.candidateId);
  return { result, candidate, validation, projected };
}

async function expectCleanNegative(input: Parameters<typeof runChannelInspection>[0]) {
  const result = await runChannelInspection({...input, creatorLikelyTrading: false, urlFailureHistoryLoader: async () => []});
  assert.equal(result.foundInvite, null);
  assert.equal(result.acquisitionStatus, 'INSPECTED_NO_MATCH');
  assert.equal(result.retryDirective, undefined);
  const channel = blankChannel();
  let enqueued = 0;
  await projectNotFoundAfterInspection(
    channel,
    result,
    result,
    true,
    async () => { enqueued += 1; },
  );
  assert.equal(channel.discord_status, 'NOT_FOUND');
  assert.equal(channel.discord_validation_status, 'COMPLETED');
  assert.equal(channel.scan_status, 'COMPLETED');
  assert.equal(enqueued, 0, 'a genuinely inspected negative schedules no retry');
  return result;
}

async function expectPending(
  input: Parameters<typeof runChannelInspection>[0],
  expectedStatus: 'PARTIALLY_INSPECTED' | 'ACQUISITION_FAILED' = 'PARTIALLY_INSPECTED',
) {
  const result = await runChannelInspection({...input, creatorLikelyTrading: false, urlFailureHistoryLoader: async () => []});
  assert.equal(result.foundInvite, null);
  assert.equal(result.acquisitionStatus, expectedStatus);
  assert.ok(result.retryDirective, 'uninspected surface owns a retry directive');
  const pending = detectPendingDiscoveryWork(
    {
      discord_candidate_locator: null,
      discord_validation_status: 'NOT_STARTED',
      discord_discovery_status: 'NOT_DISCOVERED',
    },
    result,
  );
  assert.equal(pending.pending, true);
  assert.ok(pending.reasons.includes('community-retry-directive'));

  const channel = blankChannel();
  let enqueued = 0;
  let directive: unknown;
  await projectNotFoundAfterInspection(
    channel,
    result,
    result,
    true,
    async (_channelId, value) => {
      enqueued += 1;
      directive = value;
    },
  );
  assert.equal(channel.discord_status, 'UNCERTAIN');
  assert.equal(channel.discord_validation_status, 'RETRY_PENDING');
  assert.equal(channel.scan_status, 'FAILED');
  assert.equal(enqueued, 1, 'the pending projection schedules exactly one durable retry');
  assert.equal((directive as { retryReason?: unknown })?.retryReason, 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
  return result;
}

test('M1 H1: Discord server page -> candidate -> validation -> projection', async () => {
  await expectFound({
    channelId: 'e2e-h1',
    channelName: 'E2E Test Creator',
    channelBio: 'No invite',
    channelLinks: ['https://discord.com/servers/trading-322850917248663552'],
    videoDescriptions: DESCRIPTIONS,
    externalFetchImpl: (async (input: any) => {
      assert.match(String(input), /discord\.com\/servers\/trading-322850917248663552/);
      return html('<a href="https://discord.gg/h1-room">Join</a>');
    }) as typeof fetch,
  }, 'h1-room', ['CHANNEL_EXTERNAL_LINKS']);
});

test('M1 H3: the tenth acquired description is inspected and projected', async () => {
  const descriptions = Array.from({ length: 10 }, (_, index) =>
    index === 9 ? 'Join https://discord.gg/h3-room' : `upload ${index + 1}`);
  await expectFound({
    channelId: 'e2e-h3',
    channelName: 'E2E Test Creator',
    channelBio: 'No invite',
    channelLinks: [],
    videoDescriptions: descriptions,
  }, 'h3-room', ['RECENT_VIDEO_DESCRIPTIONS']);
});

test('M1 L1: pinned-comment candidate carries provenance through projection', async () => {
  const { candidate } = await expectFound({
    channelId: 'e2e-l1',
    channelName: 'E2E Test Creator',
    channelBio: 'No invite',
    channelLinks: [],
    pinnedComment: 'Pinned: https://discord.gg/l1-room',
    videoDescriptions: DESCRIPTIONS,
  }, 'l1-room', ['PINNED_COMMENT']);
  assert.equal(candidate.ownershipStatus, 'UNCERTAIN', 'a pinned comment alone is not ownership-proof');
});

test('M1 M2a: static formaction is extracted; M2b click exclusion is covered by its browser suite', async () => {
  await expectFound({
    channelId: 'e2e-m2',
    channelName: 'E2E Test Creator',
    channelBio: 'No invite',
    channelLinks: ['https://creator.example/'],
    videoDescriptions: DESCRIPTIONS,
    externalFetchImpl: (async (input: any) => {
      const url = String(input);
      if (url === 'https://creator.example/') {
        return html('<form><button formaction="/community">Join our community</button></form>');
      }
      if (url === 'https://creator.example/community') {
        return html('<a href="https://discord.gg/m2-room">Join</a>');
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch,
  }, 'm2-room', ['CREATOR_WEBSITES']);
});

test('M1 M4a: Discord widget iframe resolves through widget.json and projects', async () => {
  const calls: string[] = [];
  const widgetIframeUrl = 'https://discord.com/widget?id=322850917248663552';
  const { result } = await expectFound({
    channelId: 'e2e-m4a',
    channelName: 'E2E Test Creator',
    channelBio: 'No invite',
    channelLinks: ['https://creator.example/'],
    videoDescriptions: DESCRIPTIONS,
    externalFetchImpl: (async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://creator.example/') return html(`<iframe src="${widgetIframeUrl}"></iframe>`);
      if (url.includes('/widget.json')) {
        return json({ name: 'Futures Trading', instant_invite: 'https://discord.gg/m4a-room' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch,
  }, 'm4a-room', ['CREATOR_WEBSITES']);
  assert.ok(calls.some(url => url.includes('/widget.json')), 'the public widget JSON is fetched');
  assert.ok(!calls.includes(widgetIframeUrl), 'the cross-origin widget iframe HTML is never fetched');
  const widgetOutcome = result.acquisitionOutcomes?.find(outcome => outcome.requestedUrl.includes('/widget?id='));
  assert.equal(widgetOutcome?.required, false, 'the optional parent site keeps the widget failure optional');
});

test('M1 M4b: same-origin iframe candidate flows through validation and projection', async () => {
  await expectFound({
    channelId: 'e2e-m4b',
    channelName: 'E2E Test Creator',
    channelBio: 'No invite',
    channelLinks: ['https://creator.example/'],
    videoDescriptions: DESCRIPTIONS,
    externalFetchImpl: (async (input: any) => {
      const url = String(input);
      if (url === 'https://creator.example/') return html('<iframe src="/frame"></iframe>');
      if (url === 'https://creator.example/frame') {
        return html('<a href="https://discord.gg/m4b-room">Join</a>');
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch,
  }, 'm4b-room', ['CREATOR_WEBSITES']);
});

test('M1 dedupe/ownership: the same invite from H1 and L1 collapses to one owned candidate', async () => {
  const { candidate } = await expectFound({
    channelId: 'e2e-dedupe',
    channelName: 'E2E Test Creator',
    channelBio: 'No invite',
    channelLinks: ['https://discord.com/servers/trading-322850917248663552'],
    pinnedComment: 'Pinned: https://discord.gg/shared-room',
    videoDescriptions: DESCRIPTIONS,
    externalFetchImpl: (async (input: any) => {
      assert.match(String(input), /discord\.com\/servers\//);
      return html('<a href="https://discord.gg/shared-room">Join</a>');
    }) as typeof fetch,
  }, 'shared-room', ['CHANNEL_EXTERNAL_LINKS', 'PINNED_COMMENT']);
  assert.equal(candidate.ownershipStatus, 'CREATOR_OWNED');
  assert.equal(candidate.observations?.filter(observation => observation.sourceSurface === 'PINNED_COMMENT').length, 1);
});

test('M1 H1: a failed server-page surface stays retry-owned', async () => {
  await expectPending({
    channelId: 'e2e-h1-fail',
    channelName: 'E2E Test Creator',
    channelBio: 'No invite',
    channelLinks: ['https://discord.com/servers/trading-322850917248663552'],
    videoDescriptions: DESCRIPTIONS,
    externalFetchImpl: (async () => html('unavailable', 503)) as typeof fetch,
  }, 'ACQUISITION_FAILED');
});

test('M1 H2: a confirmed optional 404 is a clean negative with no retry', async () => {
  const calls: string[] = [];
  const result = await expectCleanNegative({
    channelId: 'e2e-h2-clean',
    channelName: 'E2E Test Creator',
    channelBio: 'https://creator.example/missing',
    channelLinks: [],
    videoDescriptions: DESCRIPTIONS,
    externalFetchImpl: (async (input: any) => {
      calls.push(String(input));
      return html('<h1>Page not found</h1><p>This page does not exist.</p>', 404);
    }) as typeof fetch,
  });
  assert.ok(calls.includes('https://creator.example/missing'));
  const outcome = result.acquisitionOutcomes?.find(item =>
    item.surface === 'CREATOR_WEBSITES' && item.requestedUrl.includes('/missing'));
  assert.equal(outcome?.httpStatus, 404);
  assert.equal(outcome?.staticNotFoundBodyConfirmed, true);
});

test('M1 H2: an optional 503 remains partial and owns durable retry work', async () => {
  await expectPending({
    channelId: 'e2e-h2-partial',
    channelName: 'E2E Test Creator',
    channelBio: 'https://creator.example/',
    channelLinks: [],
    videoDescriptions: DESCRIPTIONS,
    externalFetchImpl: (async () => html('unavailable', 503)) as typeof fetch,
  });
});

test('M1 M4b: a failed same-origin iframe cannot become a clean negative', async () => {
  await expectPending({
    channelId: 'e2e-m4b-partial',
    channelName: 'E2E Test Creator',
    channelBio: 'No invite',
    channelLinks: ['https://creator.example/'],
    videoDescriptions: DESCRIPTIONS,
    externalFetchImpl: (async (input: any) => {
      const url = String(input);
      if (url === 'https://creator.example/') return html('<iframe src="/frame"></iframe>');
      throw new Error('same-origin frame unavailable');
    }) as typeof fetch,
  });
});

test('M1 M4a: a failed widget fetch stays partial and retry-owned', async () => {
  await expectPending({
    channelId: 'e2e-m4a-fail',
    channelName: 'E2E Test Creator',
    channelBio: 'No invite',
    channelLinks: ['https://creator.example/'],
    videoDescriptions: DESCRIPTIONS,
    externalFetchImpl: (async (input: any) => {
      const url = String(input);
      if (url === 'https://creator.example/') {
        return html('<iframe src="https://discord.com/widget?id=322850917248663552"></iframe>');
      }
      if (url.includes('/widget.json')) return html('unavailable', 503);
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch,
  });
});

test('M1 runs without a configured database', () => {
  assert.equal(process.env.DATABASE_URL, undefined, 'the suite must not connect to a configured developer database');
});
