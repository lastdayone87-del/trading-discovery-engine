import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveChannelListingServingScope } from './db';

const serving={predicate:"country_status <> 'REJECTED' AND trading_status <> 'NON_TRADING'",scope:'ELIGIBLE_OPERATOR_VISIBLE_CHANNELS'};

test('normal dashboard keeps the governed visible corpus',()=>{
  assert.deepEqual(resolveChannelListingServingScope(serving,false,false),serving);
});

test('include rejected without diagnostics remains the explicit all-channel escape hatch',()=>{
  assert.deepEqual(resolveChannelListingServingScope(serving,true,false),{predicate:'TRUE',scope:'ALL_CHANNELS'});
});

test('diagnostics-only is the exact complement of the active dashboard serving predicate',()=>{
  assert.deepEqual(resolveChannelListingServingScope(serving,true,true),{predicate:`NOT (${serving.predicate})`,scope:'DIAGNOSTICS_ONLY:ELIGIBLE_OPERATOR_VISIBLE_CHANNELS'});
});
