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
