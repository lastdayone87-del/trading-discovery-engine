import assert from 'node:assert/strict';
import test from 'node:test';
import { isReusableStaticRootLender } from './inspector';
import { runChannelInspectionForTest as runChannelInspection } from './testCrawlHelpers';

const html = (body: string, status = 200) =>
  new Response(`<html><body>${body}</body></html>`, { status, headers: { 'content-type': 'text/html' } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const base = ['one', 'two', 'three', 'four', 'five'];

let nextFrameTestId = 0;
async function inspectWithFrames(seedHtml: string, pages: Record<string, string>) {
  const calls: string[] = [];
  const result = await runChannelInspection({
    channelId: `m4-${++nextFrameTestId}`,
    channelName: 'M4 Frames',
    channelBio: 'No invite',
    channelLinks: ['https://creator.example/'],
    videoDescriptions: base,
    externalFetchImpl: (async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://creator.example/') return html(seedHtml);
      if (Object.prototype.hasOwnProperty.call(pages, url)) return html(pages[url]);
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch,
  });
  return { result, calls };
}

test('M4b inspects a same-origin iframe and retains candidate provenance', async () => {
  const { result, calls } = await inspectWithFrames(
    '<iframe src="/frame"></iframe>',
    { 'https://creator.example/frame': '<a href="https://discord.gg/frame-room">Join</a>' },
  );
  assert.equal(result.foundInvite, 'frame-room');
  assert.ok(calls.includes('https://creator.example/frame'));
  assert.equal(result.discordCandidates?.[0]?.sourceUrl, 'https://creator.example/frame');
});

test('M4b never traverses cross-origin iframe content', async () => {
  const { result, calls } = await inspectWithFrames(
    '<iframe src="https://other.example/frame"></iframe>',
    {},
  );
  assert.equal(result.foundInvite, null);
  assert.deepEqual(calls, ['https://creator.example/']);
});

test('M4b traverses nested same-origin iframes up to the bounded depth', async () => {
  const { result, calls } = await inspectWithFrames(
    '<iframe src="/a"></iframe>',
    {
      'https://creator.example/a': '<iframe src="/b"></iframe>',
      'https://creator.example/b': '<a href="https://discord.gg/nested-room">Join</a>',
    },
  );
  assert.equal(result.foundInvite, 'nested-room');
  assert.ok(calls.includes('https://creator.example/a'));
  assert.ok(calls.includes('https://creator.example/b'));
});

test('M4b marks coverage partial when a same-origin iframe exceeds the depth bound', async () => {
  const { result, calls } = await inspectWithFrames(
    '<iframe src="/a"></iframe>',
    {
      'https://creator.example/a': '<iframe src="/b"></iframe>',
      'https://creator.example/b': '<iframe src="/c"></iframe>',
      'https://creator.example/c': '<a href="https://discord.gg/too-deep">Join</a>',
    },
  );
  assert.equal(result.foundInvite, null);
  assert.equal(result.acquisitionStatus, 'PARTIALLY_INSPECTED');
  assert.ok(result.retryDirective, 'the unchecked same-origin frame must own retry work');
  assert.ok(!calls.includes('https://creator.example/c'));
});

test('M4b parses same-origin iframe srcdoc content with synthetic provenance', async () => {
  const { result } = await inspectWithFrames(
    `<iframe srcdoc="&lt;a href='https://discord.gg/srcdoc-room'&gt;Join&lt;/a&gt;"></iframe>`,
    {},
  );
  assert.equal(result.foundInvite, 'srcdoc-room');
  assert.match(result.discordCandidates?.[0]?.sourceUrl || '', /#iframe-srcdoc-0$/);
});

test('M4b skips sandboxed opaque iframe content', async () => {
  const { result, calls } = await inspectWithFrames(
    '<iframe sandbox src="/frame"></iframe>',
    { 'https://creator.example/frame': '<a href="https://discord.gg/sandbox-room">Join</a>' },
  );
  assert.equal(result.foundInvite, null);
  assert.deepEqual(calls, ['https://creator.example/']);
});

test('M4b handles empty frames without fetching or failing', async () => {
  const { result, calls } = await inspectWithFrames(
    '<iframe></iframe><iframe src="about:blank"></iframe>',
    {},
  );
  assert.equal(result.foundInvite, null);
  assert.equal(result.acquisitionStatus, 'INSPECTED_NO_MATCH');
  assert.deepEqual(calls, ['https://creator.example/']);
});

test('M4b same-origin iframe failure is partial and retryable', async () => {
  const { result, calls } = await inspectWithFrames(
    '<iframe src="/frame"></iframe>',
    {},
  );
  assert.equal(result.foundInvite, null);
  assert.equal(result.acquisitionStatus, 'PARTIALLY_INSPECTED');
  assert.ok(result.retryDirective);
  assert.ok(calls.includes('https://creator.example/frame'));
});

test('M4a Discord widget iframe uses the public widget surface, never the frame HTML', async () => {
  const calls: string[] = [];
  const result = await runChannelInspection({
    channelId: 'm4-widget',
    channelName: 'M4 Widget',
    channelBio: 'No invite',
    channelLinks: ['https://creator.example/'],
    videoDescriptions: base,
    externalFetchImpl: (async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://creator.example/') {
        return html('<iframe src="https://discord.com/widget?id=322850917248663552"></iframe>');
      }
      if (url.includes('/widget.json')) {
        return json({ name: 'Trading Floor', instant_invite: 'https://discord.gg/widget-frame-room' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch,
  });

  assert.equal(result.foundInvite, 'widget-frame-room');
  assert.ok(calls.some(url => url.includes('/widget.json')));
  assert.ok(!calls.includes('https://discord.com/widget?id=322850917248663552'));
});

test('M4b traverses a sandboxed frame that explicitly allows same-origin', async () => {
  const { result, calls } = await inspectWithFrames(
    '<iframe sandbox="allow-same-origin" src="/frame"></iframe>',
    { 'https://creator.example/frame': '<a href="https://discord.gg/sandbox-allowed">Join</a>' },
  );
  assert.equal(result.foundInvite, 'sandbox-allowed');
  assert.ok(calls.includes('https://creator.example/frame'));
});

test('M4a ignores malformed Discord widget iframes', async () => {
  const { result, calls } = await inspectWithFrames(
    '<iframe src="https://discord.com/widget?id=abc"></iframe>',
    {},
  );
  assert.equal(result.foundInvite, null);
  assert.equal(result.acquisitionStatus, 'INSPECTED_NO_MATCH');
  assert.deepEqual(calls, ['https://creator.example/']);
});

test('M4b rejects a misleading sandbox token that is not allow-same-origin', async () => {
  const { result, calls } = await inspectWithFrames(
    '<iframe sandbox="not-allow-same-origin" src="/frame"></iframe>',
    { 'https://creator.example/frame': '<a href="https://discord.gg/not-allowed">Join</a>' },
  );
  assert.equal(result.foundInvite, null);
  assert.deepEqual(calls, ['https://creator.example/']);
});

test('M4b resolves srcdoc relative links against the embedding document base', async () => {
  const { result, calls } = await inspectWithFrames(
    `<base href="/community/"><iframe srcdoc="&lt;a href='join'&gt;Join&lt;/a&gt;"></iframe>`,
    { 'https://creator.example/community/join': '<a href="https://discord.gg/srcdoc-base-room">Join</a>' },
  );
  assert.equal(result.foundInvite, 'srcdoc-base-room');
  assert.ok(calls.includes('https://creator.example/community/join'));
});

test('M4b rejects a cross-origin frame redirect before contacting it', async () => {
  const calls: string[] = [];
  const result = await runChannelInspection({
    channelId: 'm4-redirect',
    channelName: 'M4 Redirect',
    channelBio: 'No invite',
    channelLinks: ['https://creator.example/'],
    videoDescriptions: base,
    externalFetchImpl: (async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://creator.example/') return html('<iframe src="/frame"></iframe>');
      if (url === 'https://creator.example/frame') {
        return new Response(null, { status: 302, headers: { location: 'https://other.example/private' } });
      }
      throw new Error(`cross-origin redirect must not be contacted: ${url}`);
    }) as typeof fetch,
  });

  assert.equal(result.foundInvite, null);
  assert.equal(result.acquisitionStatus, 'PARTIALLY_INSPECTED');
  assert.ok(result.retryDirective);
  assert.ok(!calls.includes('https://other.example/private'));
});

test('M4b applies crawl admission before fetching a same-origin resource frame', async () => {
  const { result, calls } = await inspectWithFrames(
    '<iframe src="/logo.png"></iframe>',
    {},
  );
  assert.equal(result.foundInvite, null);
  assert.deepEqual(calls, ['https://creator.example/']);
});

test('M4b classifies a timed-out same-origin iframe as partial and retryable', async () => {
  const calls: string[] = [];
  const result = await runChannelInspection({
    channelId: 'm4-timeout',
    channelName: 'M4 Timeout',
    channelBio: 'No invite',
    channelLinks: ['https://creator.example/'],
    videoDescriptions: base,
    externalFetchImpl: (async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://creator.example/') return html('<iframe src="/frame"></iframe>');
      if (url === 'https://creator.example/frame') {
        throw Object.assign(new Error('frame timed out'), { name: 'AbortError' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch,
  });

  assert.equal(result.foundInvite, null);
  assert.equal(result.acquisitionStatus, 'PARTIALLY_INSPECTED');
  assert.ok(result.retryDirective);
  assert.ok(calls.includes('https://creator.example/frame'));
});

test('M4a records optional widget failures as optional and keeps creator-page provenance', async () => {
  const calls: string[] = [];
  const result = await runChannelInspection({
    channelId: 'm4-widget-provenance',
    channelName: 'M4 Widget Provenance',
    channelBio: 'No invite',
    channelLinks: ['https://creator.example/'],
    videoDescriptions: base,
    externalFetchImpl: (async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://creator.example/') {
        return html('<iframe src="https://discord.com/widget?id=322850917248663552"></iframe>');
      }
      if (url.includes('/widget.json')) return json({ instant_invite: 'https://discord.gg/provenance-widget' });
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch,
  });

  assert.equal(result.foundInvite, 'provenance-widget');
  const candidate = result.discordCandidates?.[0];
  assert.ok(candidate?.observations?.some(observation =>
    observation.sourceSurface === 'CREATOR_WEBSITES'
    && observation.sourceUrl === 'https://creator.example/'));
  const widgetOutcome = result.acquisitionOutcomes?.find(outcome => outcome.requestedUrl.includes('/widget?id='));
  assert.equal(widgetOutcome?.required, false, 'a widget on an optional website must stay optional');
});

test('M4a marks the seed partial when the Discord iframe surface cap is exceeded', async () => {
  const calls: string[] = [];
  const ids = Array.from({ length: 6 }, (_, index) => `10000000000000000${index + 1}`);
  const frames = ids.map(id => `<iframe src="https://discord.com/widget?id=${id}"></iframe>`).join('');
  const result = await runChannelInspection({
    channelId: 'm4-widget-cap',
    channelName: 'M4 Widget Cap',
    channelBio: 'No invite',
    channelLinks: ['https://creator.example/'],
    videoDescriptions: base,
    externalFetchImpl: (async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://creator.example/') return html(frames);
      if (url.includes('/widget.json')) {
        if (url.includes(ids[5]!)) return json({ instant_invite: 'https://discord.gg/over-cap-widget' });
        return json({});
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch,
  });

  assert.equal(result.foundInvite, null);
  assert.equal(result.acquisitionStatus, 'PARTIALLY_INSPECTED');
  assert.ok(result.retryDirective);
  assert.ok(!calls.some(url => url.includes(ids[5]!)), 'the sixth widget is not fetched after the cap');
});

test('M4b shared-root lenders with iframe content are not reused', () => {
  assert.equal(isReusableStaticRootLender({
    outcome: 'FOUND',
    visitedUrls: ['https://creator.example/'],
    rootNavigation: [],
    hasIframeContent: true,
  }), false);
  assert.equal(isReusableStaticRootLender({
    outcome: 'FOUND',
    visitedUrls: ['https://creator.example/'],
    rootNavigation: [],
  }), true);
});
