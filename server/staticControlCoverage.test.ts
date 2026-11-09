import assert from 'node:assert/strict';
import test from 'node:test';
import { runChannelInspectionForTest as runChannelInspection } from './testCrawlHelpers';

const html = (body: string) =>
  new Response(`<html><body>${body}</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });

const seedFor = (control: string) => html(control);
const roomPage = (code: string) => html(`<div>Join the community: https://discord.gg/${code}</div>`);

async function inspectSeed(control: string, code: string) {
  const calls: string[] = [];
  const result = await runChannelInspection({
    channelId: `m2a-${code}`,
    channelName: 'M2a Channel',
    channelBio: 'No invite',
    channelLinks: ['https://creator.example/'],
    videoDescriptions: ['one', 'two', 'three', 'four', 'five'],
    externalFetchImpl: (async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://creator.example/') return seedFor(control);
      if (url === 'https://creator.example/community') return roomPage(code);
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch,
  });
  return { result, calls };
}

test('M2a follows a literal onclick navigation target', async () => {
  const { result, calls } = await inspectSeed(
    `<div onclick="location.assign('/community')">Join the community</div>`,
    'onclick-room',
  );
  assert.equal(result.foundInvite, 'onclick-room');
  assert.ok(calls.includes('https://creator.example/community'));
  assert.equal(result.steps.find(step => step.step === 'CUSTOM_DOMAINS')?.status, 'FOUND');
});

test('M2a follows a literal formaction control target', async () => {
  const { result, calls } = await inspectSeed(
    `<button formaction="/community">Join the community</button>`,
    'formaction-room',
  );
  assert.equal(result.foundInvite, 'formaction-room');
  assert.ok(calls.includes('https://creator.example/community'));
});

test('M2a follows a literal meta-refresh target', async () => {
  const { result, calls } = await inspectSeed(
    `<meta http-equiv="refresh" content="0; '/community'">`,
    'meta-room',
  );
  assert.equal(result.foundInvite, 'meta-room');
  assert.ok(calls.includes('https://creator.example/community'));
});

test('M2a does not evaluate excluded controls or navigate their URLs', async () => {
  const calls: string[] = [];
  const result = await runChannelInspection({
    channelId: 'm2a-excluded',
    channelName: 'M2a Excluded',
    channelBio: 'No invite',
    channelLinks: ['https://creator.example/'],
    videoDescriptions: ['one', 'two', 'three', 'four', 'five'],
    externalFetchImpl: (async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://creator.example/') {
        return seedFor(`
          <div onclick="doSomething('https://evil.example/community')">Nope</div>
          <button formaction="javascript:alert(1)">Nope</button>
          <button type="button" formaction="/not-a-submit">Nope</button>
          <div onclick="location.assign('/x?'+id)">Nope</div>
        `);
      }
      throw new Error(`excluded control must not be fetched: ${url}`);
    }) as typeof fetch,
  });

  assert.equal(result.foundInvite, null);
  assert.deepEqual(calls, ['https://creator.example/']);
});

test('M2a marks the seed partial and retryable when the control cap drops a target', async () => {
  const calls: string[] = [];
  const unrelated = Array.from({ length: 20 }, (_, index) =>
    `<div onclick="window.open('https://unrelated-${index}.example/start')">Start</div>`).join('');
  const result = await runChannelInspection({
    channelId: 'm2a-cap',
    channelName: 'M2a Cap',
    channelBio: 'No invite',
    channelLinks: ['https://creator.example/'],
    videoDescriptions: ['one', 'two', 'three', 'four', 'five'],
    externalFetchImpl: (async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://creator.example/') {
        return seedFor(`${unrelated}<div onclick="window.open('/community')">Join our community</div>`);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch,
  });

  assert.equal(result.foundInvite, null);
  assert.equal(result.acquisitionStatus, 'PARTIALLY_INSPECTED');
  assert.ok(result.retryDirective, 'a control-slice cap must own retry work');
  const observation = result.acquisitionOutcomes?.find(outcome =>
    outcome.surface === 'CREATOR_WEBSITES' && outcome.outcome === 'PARTIALLY_INSPECTED');
  assert.equal(observation?.outcome, 'PARTIALLY_INSPECTED');
  assert.equal(observation?.retryable, true);
  assert.equal(observation?.failureClass, 'STATIC_BUDGET_GAP');
  assert.deepEqual(calls, ['https://creator.example/']);
});

test('M2a direct control invites keep the control label as anchor provenance', async () => {
  const result = await runChannelInspection({
    channelId: 'm2a-provenance',
    channelName: 'M2a Provenance',
    channelBio: 'No invite',
    channelLinks: ['https://creator.example/'],
    videoDescriptions: ['one', 'two', 'three', 'four', 'five'],
    externalFetchImpl: (async (input: any) => {
      const url = String(input);
      if (url === 'https://creator.example/') {
        return seedFor('<button formaction="https://discord.gg/control-room" aria-label="Join our community">Open</button>');
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch,
  });

  assert.equal(result.foundInvite, 'control-room');
  const candidate = result.discordCandidates?.find(item => item.nativeInviteCode === 'control-room');
  assert.ok(candidate?.observations?.some(observation =>
    observation.sourceSurface === 'CREATOR_WEBSITES'
    && observation.sourceAnchorText === 'Join our community'));
});

test('M2a control labels can admit a destination the dynamic scan rejected', async () => {
  const calls: string[] = [];
  const result = await runChannelInspection({
    channelId: 'm2a-label-upgrade',
    channelName: 'M2a Label Upgrade',
    channelBio: 'No invite',
    channelLinks: ['https://creator.example/'],
    videoDescriptions: ['one', 'two', 'three', 'four', 'five'],
    externalFetchImpl: (async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://creator.example/') {
        return seedFor(`<button onclick="location.href='https://other.example/start'">Join our community</button>`);
      }
      if (url === 'https://other.example/start') return roomPage('label-upgraded-room');
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch,
  });

  assert.equal(result.foundInvite, 'label-upgraded-room');
  assert.ok(calls.includes('https://other.example/start'),
    'the control label must upgrade the URL-only dynamic decision');
});

test('M2a dynamic duplicates do not consume the fresh control cap', async () => {
  const calls: string[] = [];
  const dynamic = Array.from({ length: 20 }, (_, index) =>
    `<div onclick="location.href='https://unrelated-${index}.example/start'">Start</div>`).join('');
  const result = await runChannelInspection({
    channelId: 'm2a-dynamic-cap',
    channelName: 'M2a Dynamic Cap',
    channelBio: 'No invite',
    channelLinks: ['https://creator.example/'],
    videoDescriptions: ['one', 'two', 'three', 'four', 'five'],
    externalFetchImpl: (async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://creator.example/') {
        return seedFor(`${dynamic}<div onclick="window.open('/community')">Join our community</div>`);
      }
      if (url === 'https://creator.example/community') return roomPage('dynamic-cap-room');
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch,
  });

  assert.equal(result.foundInvite, 'dynamic-cap-room');
  assert.ok(calls.includes('https://creator.example/community'),
    'dynamic duplicates must not displace an M2a-only target');
});
