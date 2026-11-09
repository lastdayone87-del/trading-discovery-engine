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
    `<div onclick="location.href='/community'">Join the community</div>`,
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
    `<meta http-equiv="refresh" content="0; url='/community'">`,
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
