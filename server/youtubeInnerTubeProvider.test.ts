import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseInnerTubeLane, discoverWithInnerTube, getInnerTubeProviderHealth, resetInnerTubeProviderHealthForTests } from './youtubeInnerTubeProvider';

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
  assert.equal(result.channels.length, 2);
  assert.equal(result.channels[0].matchedDocument?.type, 'VIDEO');
  assert.ok(result.channels[0].matchedDocument?.publishedAt);
});

test('dedupes channels before expensive enrichment', async () => {
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

test('provider failure enters a bounded cooldown and records health', async () => {
  resetInnerTubeProviderHealthForTests();
  const client = { async search() { throw new Error('rate limited'); } };
  await assert.rejects(() => discoverWithInnerTube('forex trading', {}, client as any), /rate limited/);
  const month = getInnerTubeProviderHealth().find(x => x.lane === 'MONTH')!;
  assert.equal(month.failures, 1);
  assert.ok(month.coolingDownUntil);
});

test('lane policy stays MONTH-first, then YEAR, with DEFAULT only as long-tail', () => {
  assert.equal(chooseInnerTubeLane({ monthAttempts: 0, monthUniqueYield: 0 }), 'MONTH');
  assert.equal(chooseInnerTubeLane({ monthAttempts: 3, monthUniqueYield: 12 }), 'MONTH');
  assert.equal(chooseInnerTubeLane({ monthAttempts: 3, monthUniqueYield: 1, yearAttempts: 0 }), 'YEAR');
  assert.equal(chooseInnerTubeLane({ monthAttempts: 3, monthUniqueYield: 1, yearAttempts: 3 }), 'DEFAULT');
});
