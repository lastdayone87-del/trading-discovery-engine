import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; import { dirname, join } from 'node:path'; import { fileURLToPath } from 'node:url'; import { aggregatePageMetrics } from './autonomousPageStore';
test('aggregates pages into one final learning measurement without counting review states as quality',()=>{const page=(overrides:any)=>({rawResults:10,distinctResults:8,duplicateResults:2,knownChannels:1,newChannels:7,countryRejected:1,nonTrading:1,uncertain:1,needsReview:1,tradingConfirmed:4,qualityChannels:2,communitiesDiscovered:1,averageQualityScore:60,noveltyRatio:.875,countryPrecision:.875,tradingPrecision:.57,performanceScore:60,...overrides});const total=aggregatePageMetrics([page({}),page({qualityChannels:1,tradingConfirmed:2,needsReview:3})]);assert.equal(total.rawResults,20);assert.equal(total.qualityChannels,3);assert.equal(total.tradingConfirmed,6);assert.equal(total.needsReview,4);});
test('scope weighting survives page aggregation; legacy pages stay neutral',()=>{
  const scoped=(inScopeNewChannels:number)=>({rawResults:10,distinctResults:8,duplicateResults:2,knownChannels:1,newChannels:7,inScopeNewChannels,countryRejected:1,nonTrading:1,uncertain:1,needsReview:1,tradingConfirmed:4,qualityChannels:2,communitiesDiscovered:1,averageQualityScore:60,noveltyRatio:.875,countryPrecision:.875,tradingPrecision:.57,performanceScore:60});
  const legacy=()=>({rawResults:10,distinctResults:8,duplicateResults:2,knownChannels:1,newChannels:7,countryRejected:1,nonTrading:1,uncertain:1,needsReview:1,tradingConfirmed:4,qualityChannels:2,communitiesDiscovered:1,averageQualityScore:60,noveltyRatio:.875,countryPrecision:.875,tradingPrecision:.57,performanceScore:60});
  assert.equal(aggregatePageMetrics([scoped(2),scoped(5)]).inScopeNewChannels,7);
  assert.equal(aggregatePageMetrics([legacy(),legacy()]).inScopeNewChannels,undefined);
  // Mixed-version runs: legacy pages contribute neutral full credit.
  assert.equal(
    aggregatePageMetrics([{ ...legacy(), newChannels: 7 }, { ...scoped(2), newChannels: 7 }]).inScopeNewChannels,
    9,
  );
});
test('run-wide metrics keep the rejected count on the same distinct set as the denominator',()=>{
  const source=readFileSync(join(dirname(fileURLToPath(import.meta.url)),'autonomousPageStore.ts'),'utf8');
  // A per-page rejected sum against a run-wide distinct denominator can
  // exceed the denominator (two rejects repeated on two pages). Both sides
  // must come from channel_sightings for the run.
  assert.match(source,/COUNT\(DISTINCT channel_id\) FILTER \(WHERE country_outcome='REJECTED'\)/);
  assert.match(source,/countryRejected:rejected,/);
  assert.match(source,/countryPrecision:\(distinct-rejected\)\/distinct/);
});
