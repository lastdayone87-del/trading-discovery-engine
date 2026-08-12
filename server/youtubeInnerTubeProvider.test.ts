import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseInnerTubeLane, discoverWithInnerTube, getInnerTubeProviderHealth, nextInnerTubeLane, resetInnerTubeProviderHealthForTests } from './youtubeInnerTubeProvider';

function page(items: any[], continuation?: any) {
  return {
    videos: items,
    has_continuation: Boolean(continuation),
    getContinuation: continuation ? async () => continuation : undefined
  };
}

test('MONTH is the default production lane and pagination is bounded', async () => {
  resetInnerTubeProviderHealthForTests();
  let optionsSeen: any;
  const second = page([{ id: 'v2', title: { text: 'Futures trading live' }, author: { id: 'UC2', name: 'Trader Two' }, published: { text: '2 days ago' } }]);
  const client = {
    async search(_query: string, options: any) {
      optionsSeen = options;
      return page([{ id: 'v1', title: { text: 'Day trading setup' }, author: { id: 'UC1', name: 'Trader One' }, published: { text: '1 day ago' } }], second);
    }
  };
  const result = await discoverWithInnerTube('day trading', { maxPages: 2 }, client as any);
  assert.equal(result.lane, 'MONTH');
  assert.deepEqual(optionsSeen, { type: 'video', upload_date: 'month' });
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.rawCandidateCount, 2);
  assert.equal(result.channels.length, 2);
  assert.equal(result.channels[0].matchedDocument?.type, 'VIDEO');
  assert.ok(result.channels[0].matchedDocument?.publishedAt);
});

test('dedupes channels before expensive enrichment while retaining raw yield', async () => {
  resetInnerTubeProviderHealthForTests();
  const client = {
    async search() {
      return page([
        { id: 'a', title: { text: 'Trading A' }, author: { id: 'UCsame', name: 'Same Trader' }, published: { text: 'today' } },
        { id: 'b', title: { text: 'Trading B' }, author: { id: 'UCsame', name: 'Same Trader' }, published: { text: 'today' } }
      ]);
    }
  };
  const result = await discoverWithInnerTube('stocks trading', {}, client as any);
  assert.equal(result.rawCandidateCount, 2);
  assert.equal(result.channels.length, 1);
});

test('YEAR lane is explicit and does not silently broaden to default', async () => {
  resetInnerTubeProviderHealthForTests();
  let optionsSeen: any;
  const client = { async search(_q: string, options: any) { optionsSeen = options; return page([]); } };
  const result = await discoverWithInnerTube('trading deutsch', { lane: 'YEAR' }, client as any);
  assert.equal(result.lane, 'YEAR');
  assert.deepEqual(optionsSeen, { type: 'video', upload_date: 'year' });
});

test('live/upcoming results without a normal published age are treated as current routing evidence', async () => {
  resetInnerTubeProviderHealthForTests();
  const client = { async search() { return page([{ id: 'live1', title: { text: 'Live futures trading now' }, author: { id: 'UCL', name: 'Live Trader' }, is_live: true }]); } };
  const result = await discoverWithInnerTube('futures trading live', {}, client as any);
  assert.ok(result.channels[0].matchedDocument?.publishedAt);
});

test('provider rate limit enters a bounded cooldown and records health', async () => {
  resetInnerTubeProviderHealthForTests();
  const client = { async search() { throw new Error('rate limited'); } };
  await assert.rejects(() => discoverWithInnerTube('forex trading', {}, client as any), (error: any) => {
    assert.equal(error.code, 'YOUTUBE_PROVIDERS_COOLING_DOWN');
    assert.ok(Number.isFinite(error.retryAt));
    return true;
  });
  const month = getInnerTubeProviderHealth().find(x => x.lane === 'MONTH')!;
  assert.equal(month.failures, 1);
  assert.ok(month.coolingDownUntil);
});

test('automatic broadening is MONTH to YEAR only; DEFAULT remains opt-in long-tail', () => {
  assert.equal(nextInnerTubeLane('MONTH', true), 'YEAR');
  assert.equal(nextInnerTubeLane('MONTH', false), null);
  assert.equal(nextInnerTubeLane('YEAR', true), null);
  assert.equal(nextInnerTubeLane('YEAR', true, true), 'DEFAULT');
  assert.equal(nextInnerTubeLane('DEFAULT', true, true), null);
});

test('legacy lane chooser remains MONTH-first, then YEAR, with DEFAULT only as long-tail', () => {
  assert.equal(chooseInnerTubeLane({ monthAttempts: 0, monthUniqueYield: 0 }), 'MONTH');
  assert.equal(chooseInnerTubeLane({ monthAttempts: 3, monthUniqueYield: 12 }), 'MONTH');
  assert.equal(chooseInnerTubeLane({ monthAttempts: 3, monthUniqueYield: 1, yearAttempts: 0 }), 'YEAR');
  assert.equal(chooseInnerTubeLane({ monthAttempts: 3, monthUniqueYield: 1, yearAttempts: 3 }), 'DEFAULT');
});
