import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; import { dirname, join } from 'node:path'; import { fileURLToPath } from 'node:url'; import { aggregatePageMetrics, getAutonomousRunMetrics } from './autonomousPageStore';
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
  // Cumulative unique creators replace the sum of overlapping page
  // populations; the last measured cumulative value wins.
  const cumulative = aggregatePageMetrics([
    { ...legacy(), cumulativeUniqueCreators: 10 },
    { ...legacy(), cumulativeUniqueCreators: 14 },
  ]);
  assert.equal(cumulative.distinctResults, 14);
  assert.equal(aggregatePageMetrics([legacy(), legacy()]).distinctResults, 16);
  // Migration default 0 is not a measured cumulative reach: positive page
  // results must keep the per-page fallback until a real cumulative is stored.
  assert.equal(
    aggregatePageMetrics([
      { ...legacy(), cumulativeUniqueCreators: 0 },
      { ...legacy(), cumulativeUniqueCreators: 0 },
    ]).distinctResults,
    16,
  );
  assert.equal(
    aggregatePageMetrics([
      { ...legacy(), cumulativeUniqueCreators: 14 },
      { ...legacy(), cumulativeUniqueCreators: 0 },
    ]).distinctResults,
    14,
  );
  assert.equal(
    aggregatePageMetrics([
      { ...legacy(), cumulativeUniqueCreators: 14 },
      { ...legacy(), distinctResults: 0, cumulativeUniqueCreators: 0 },
    ]).distinctResults,
    14,
    'a zero-result legacy page cannot erase an earlier cumulative reach',
  );
});

test('country rejections are counted once against cumulative unique reach', () => {
  const page = (overrides: Record<string, unknown>) => ({
    rawResults: 10, distinctResults: 8, duplicateResults: 2, knownChannels: 1,
    newChannels: 7, countryRejected: 3, nonTrading: 1, uncertain: 1,
    needsReview: 1, tradingConfirmed: 4, qualityChannels: 2,
    communitiesDiscovered: 1, averageQualityScore: 60, noveltyRatio: .875,
    countryPrecision: .625, tradingPrecision: .57, performanceScore: 60, ...overrides,
  });
  const cumulative = aggregatePageMetrics([
    page({ cumulativeUniqueCreators: 10, cumulativeCountryRejected: 3 }),
    page({ cumulativeUniqueCreators: 14, cumulativeCountryRejected: 4 }),
  ]);
  assert.equal(cumulative.distinctResults, 14);
  assert.equal(cumulative.countryRejected, 4, 'repeat rejections are not summed');
  assert.equal(cumulative.countryPrecision, (14 - 4) / 14);

  // Legacy rows have no cumulative rejection count. The fallback sum is
  // clamped so overlapping pages cannot produce a negative precision.
  const legacy = aggregatePageMetrics([
    page({ distinctResults: 1, countryRejected: 2 }),
    page({ distinctResults: 1, countryRejected: 2 }),
  ]);
  assert.equal(legacy.countryRejected, 2);
  assert.equal(legacy.countryPrecision, 0);
});
test('run-wide metrics keep the rejected count on the same distinct set as the denominator',()=>{
  const source=readFileSync(join(dirname(fileURLToPath(import.meta.url)),'autonomousPageStore.ts'),'utf8');
  // A per-page rejected sum against a run-wide distinct denominator can
  // exceed the denominator (two rejects repeated on two pages). Both sides
  // must come from channel_sightings for the run.
  assert.match(source,/COUNT\(DISTINCT channel_id\) FILTER \(WHERE country_outcome='REJECTED'\)/);
  // Whitespace-tolerant: this branch pretty-prints the returned object, while
  // the contract is the value identity, not the exact formatting.
  assert.match(source,/countryRejected:\s*rejected,/);
  // Pending sightings have no country verdict and stay out of both sides:
  // the denominator is the run-wide distinct set minus still-pending creators.
  assert.match(source,/classification_pending/);
  assert.match(source,/countryPrecision:\s*countryEvaluated\s*\?\s*\(countryEvaluated\s*-\s*rejected\)\s*\/\s*countryEvaluated\s*:\s*1/);
});
test('run-wide sightings recompute duplicate metrics even when the distinct total matches', async () => {
  const page = (overrides: Record<string, unknown>) => ({
    rawResults: 10, deferredResults: 0, evaluatedRawResults: 10,
    distinctResults: 6, duplicateResults: 4, knownChannels: 1, newChannels: 5,
    countryRejected: 2, nonTrading: 1, uncertain: 1, needsReview: 1,
    tradingConfirmed: 4, qualityChannels: 2, communitiesDiscovered: 1,
    averageQualityScore: 60, noveltyRatio: .5, countryPrecision: .5,
    tradingPrecision: .57, performanceScore: 60, ...overrides,
  });
  // Both pages report the same run-cumulative distinct total (6), so the old
  // distinct-count-changed guard would skip the recompute. Cross-page repeats
  // still change duplicateResults: evaluated raw = 20, unique = 6.
  const runner = {
    query: async (sql: string) => {
      if (sql.includes('FROM autonomous_query_page_observations')) {
        return { rows: [
          { page_metrics: page({}), cumulative_unique_creators: 6 },
          { page_metrics: page({}), cumulative_unique_creators: 6 },
        ] };
      }
      if (sql.includes('COUNT(*)::int AS sightings')) {
        return { rows: [{ sightings: 8, distinct_creators: 6, country_rejected: 2 }] };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    },
  };
  const metrics = await getAutonomousRunMetrics('run-1', runner);
  assert.equal(metrics.distinctResults, 6);
  assert.equal(metrics.duplicateResults, 14);
  assert.equal(metrics.countryRejected, 2);
  assert.equal(metrics.countryPrecision, (6 - 2) / 6);
});
test('run-wide metrics exclude still-pending sightings from country precision', async () => {
  const page = {
    rawResults: 4, deferredResults: 0, evaluatedRawResults: 4,
    distinctResults: 4, duplicateResults: 0, knownChannels: 0, newChannels: 4,
    countryRejected: 0, nonTrading: 0, uncertain: 0, needsReview: 0,
    tradingConfirmed: 0, qualityChannels: 0, communitiesDiscovered: 0,
    averageQualityScore: 0, noveltyRatio: 1, countryPrecision: 1,
    tradingPrecision: 0, performanceScore: 10, classificationPending: 4,
  };
  const runner = {
    query: async (sql: string) => {
      if (sql.includes('FROM autonomous_query_page_observations')) {
        return { rows: [{ page_metrics: page, cumulative_unique_creators: 4 }] };
      }
      if (sql.includes('COUNT(*)::int AS sightings')) {
        return { rows: [{ sightings: 4, distinct_creators: 4, country_rejected: 0, classification_pending: 4 }] };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    },
  };
  const metrics = await getAutonomousRunMetrics('run-2', runner);
  assert.equal(metrics.classificationPending, 4);
  assert.equal(metrics.countryPrecision, 1, 'no evaluated country outcome means no country miss');
});
test('legacy page metrics keep evaluatedRawResults absent through aggregation',()=>{
  const legacy=(overrides: Record<string, unknown> = {})=>({rawResults:10,distinctResults:8,duplicateResults:2,knownChannels:1,newChannels:7,countryRejected:1,nonTrading:1,uncertain:1,needsReview:1,tradingConfirmed:4,qualityChannels:2,communitiesDiscovered:1,averageQualityScore:60,noveltyRatio:.875,countryPrecision:.875,tradingPrecision:.57,performanceScore:60,...overrides});
  // The field is optional specifically so consumers can fall back to
  // rawResults - deferredResults. Materializing 0 would make run-wide
  // duplicates collapse to zero on legacy runs.
  assert.equal(aggregatePageMetrics([legacy()]).evaluatedRawResults, undefined);
  assert.equal(
    aggregatePageMetrics([legacy(), legacy({ rawResults: 6, deferredResults: 2, evaluatedRawResults: 4 })]).evaluatedRawResults,
    14,
    'mixed-version runs contribute the raw-minus-deferred fallback for legacy pages',
  );
});
test('legacy page metrics leave freshTradingConfirmed unknown instead of inventing zero',()=>{
  const legacy=(overrides: Record<string, unknown> = {})=>({rawResults:10,distinctResults:8,duplicateResults:2,knownChannels:1,newChannels:7,countryRejected:1,nonTrading:1,uncertain:1,needsReview:1,tradingConfirmed:4,qualityChannels:2,communitiesDiscovered:1,averageQualityScore:60,noveltyRatio:.875,countryPrecision:.875,tradingPrecision:.57,performanceScore:60,...overrides});
  assert.equal(aggregatePageMetrics([legacy()]).freshTradingConfirmed, undefined);
  assert.equal(
    aggregatePageMetrics([legacy(), legacy({ freshTradingConfirmed: 2 })]).freshTradingConfirmed,
    2,
    'a measured page still contributes; legacy pages add no invented zero',
  );
});
