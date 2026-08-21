import test from 'node:test';
import assert from 'node:assert/strict';
import { channelListingSearchParams } from './channelListingQuery';

const filters={search:'',country:'ALL',countryStatus:'ALL',tradingStatus:'ALL',discordStatus:'ALL',scanStatus:'ALL'};

test('normal dashboard does not request rejected or diagnostics rows',()=>{
  const params=channelListingSearchParams(filters,false);
  assert.equal(params.has('include_rejected'),false);
  assert.equal(params.has('diagnostics_only'),false);
});

test('diagnostics toggle requests the hidden corpus explicitly',()=>{
  const params=channelListingSearchParams(filters,true);
  assert.equal(params.get('include_rejected'),'true');
  assert.equal(params.get('diagnostics_only'),'true');
});

test('default page and revision requests do not send a low-audience filter implicitly',()=>{
  const params=channelListingSearchParams(filters,false);
  assert.equal(params.has('scan_status'),false);
});

test('explicit low-audience selection serializes alongside other filters',()=>{
  const params=channelListingSearchParams({
    ...filters,
    search:'alpha', country:'Germany', countryStatus:'CONFIRMED',
    tradingStatus:'TRADING_CONFIRMED', discordStatus:'ACTIVE', scanStatus:'SKIPPED_LOW_AUDIENCE'
  },false);
  assert.deepEqual([...params.entries()],[
    ['search','alpha'], ['country','Germany'], ['country_status','CONFIRMED'],
    ['trading_status','TRADING_CONFIRMED'], ['discord_status','ACTIVE'],
    ['scan_status','SKIPPED_LOW_AUDIENCE']
  ]);
});
