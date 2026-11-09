import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateNativeDiscovery,
  evaluateProviderYield,
  parseNativeDiscoveryCsv,
  proportion,
  wilsonInterval,
  type NativeDiscoveryLabel,
} from './nativeDiscoveryMetrics';

function label(patch: Partial<NativeDiscoveryLabel>): NativeDiscoveryLabel {
  return {
    channelId: 'c',
    country: 'France',
    language: 'fr',
    tradingRelevant: true,
    discovered: true,
    discoveredCountryMatch: true,
    discoveredLanguageMatch: true,
    quality: false,
    community: false,
    provider: 'youtube-search',
    ...patch,
  };
}

test('precision, recall, country, language and false-positive rates are computed independently', () => {
  const labels: NativeDiscoveryLabel[] = [
    label({ channelId: 'a', tradingRelevant: true, discovered: true, discoveredCountryMatch: true, discoveredLanguageMatch: true }),
    label({ channelId: 'b', tradingRelevant: true, discovered: true, discoveredCountryMatch: false, discoveredLanguageMatch: true }),
    label({ channelId: 'c', tradingRelevant: true, discovered: true, discoveredCountryMatch: true, discoveredLanguageMatch: true }),
    label({ channelId: 'd', tradingRelevant: false, discovered: true, discoveredCountryMatch: null, discoveredLanguageMatch: null }),
    label({ channelId: 'e', tradingRelevant: true, discovered: false, discoveredCountryMatch: null, discoveredLanguageMatch: null }),
    label({ channelId: 'f', tradingRelevant: true, discovered: false, discoveredCountryMatch: null, discoveredLanguageMatch: null }),
    label({ channelId: 'g', tradingRelevant: false, discovered: false, discoveredCountryMatch: null, discoveredLanguageMatch: null }),
    label({ channelId: 'h', tradingRelevant: true, discovered: false, discoveredCountryMatch: null, discoveredLanguageMatch: null }),
  ];
  const report = evaluateNativeDiscovery({ labels, generatedAt: '2026-11-09T00:00:00.000Z' });
  assert.equal(report.overall.discovered, 4);
  assert.equal(report.overall.discoveredRelevant, 3);
  assert.equal(report.overall.precision.rate, 3 / 4);
  assert.equal(report.overall.recall.rate, 3 / 6);
  assert.equal(report.overall.countryRelevance.rate, 2 / 3);
  assert.equal(report.overall.languageMatch.rate, 3 / 3);
  // One discovered negative out of two labelled negatives.
  assert.equal(report.overall.falsePositiveRate.rate, 1 / 2);
  assert.equal(report.byCountry.France.sampleSize, 8);
  assert.equal(report.byLanguage.fr.precision.rate, 3 / 4);
});

test('optional quality and community labels are excluded when unmeasured', () => {
  const report = evaluateNativeDiscovery({
    labels: [
      label({ channelId: 'a', quality: true, community: null }),
      label({ channelId: 'b', quality: null, community: true }),
      label({ channelId: 'c', quality: null, community: null }),
    ],
  });
  assert.equal(report.overall.qualityYield.total, 1);
  assert.equal(report.overall.qualityYield.rate, 1);
  assert.equal(report.overall.communityYield.total, 1);
  assert.equal(report.overall.communityYield.rate, 1);

  const unmeasured = evaluateNativeDiscovery({
    labels: [label({ channelId: 'd', quality: null, community: null })],
  });
  assert.equal(unmeasured.overall.qualityYield.rate, null);
  assert.equal(unmeasured.overall.communityYield.rate, null);
});

test('Wilson intervals are used so a target is judged on the lower bound', () => {
  const ten = wilsonInterval(3, 4);
  assert.ok(ten.lower < 3 / 4 && ten.upper > 3 / 4);
  const large = wilsonInterval(270, 300);
  assert.ok(large.lower > 0.85, `expected lower bound > 0.85, got ${large.lower}`);
  assert.ok(large.lower < 0.9 && large.upper > 0.9);
  assert.deepEqual(proportion(0, 0), { successes: 0, total: 0, rate: null, lower95: null, upper95: null });
});

test('90% evidence gate fails on a small sample and passes only with a strong lower bound', () => {
  const small = evaluateNativeDiscovery({
    labels: [label({ channelId: 'a' }), label({ channelId: 'b' }), label({ channelId: 'c' })],
  });
  assert.equal(small.evidence.meets90PercentLowerBound, false);
  assert.ok(small.evidence.marketsBelowRecommendedSample.includes('France'));

  const strong = evaluateNativeDiscovery({
    labels: Array.from({ length: 300 }, (_, index) => label({ channelId: `c${index}` })),
  });
  assert.equal(strong.evidence.meets90PercentLowerBound, true);
  assert.ok(strong.overall.precision.lower95! >= 0.9);
  assert.ok(strong.overall.recall.lower95! >= 0.9);
});

test('a strong pooled result cannot hide a failing market', () => {
  const report = evaluateNativeDiscovery({
    labels: [
      ...Array.from({ length: 300 }, (_, index) => label({ channelId: `fr${index}` })),
      ...Array.from({ length: 3 }, (_, index) => label({ channelId: `de${index}`, country: 'Germany', language: 'de' })),
    ],
  });
  assert.ok(report.overall.precision.lower95! >= 0.9);
  assert.ok(report.overall.recall.lower95! >= 0.9);
  assert.ok(report.evidence.marketsBelowRecommendedSample.includes('Germany'));
  assert.equal(report.evidence.meets90PercentLowerBound, false);
});

test('provider yield is reported per 100 requests without a binomial interval', () => {
  const [yieldRow] = evaluateProviderYield([{ provider: 'youtube-innertube', requests: 100, newConfirmedCreators: 50 }]);
  assert.equal(yieldRow.newConfirmedPer100Requests, 50);
  assert.equal('interval' in yieldRow, false);
  // One request can confirm several creators; the rate is allowed to exceed 100.
  const [highYield] = evaluateProviderYield([{ provider: 'youtube-innertube', requests: 10, newConfirmedCreators: 50 }]);
  assert.equal(highYield.newConfirmedPer100Requests, 500);
});

test('the evaluator rejects duplicate or conflicting creator identities', () => {
  assert.throws(
    () => evaluateNativeDiscovery({ labels: [label({ channelId: 'same' }), label({ channelId: 'same' })] }),
    /NATIVE_DISCOVERY_DUPLICATE_CHANNEL:same/,
  );
  assert.throws(
    () => evaluateNativeDiscovery({ labels: [label({ channelId: 'same', country: 'France' }), label({ channelId: 'same', country: 'Germany' })] }),
    /NATIVE_DISCOVERY_CONFLICTING_CHANNEL:same/,
  );
  assert.throws(
    () => evaluateNativeDiscovery({ labels: [label({ channelId: '  ' })] }),
    /NATIVE_DISCOVERY_EMPTY_CHANNEL/,
  );
});

test('CSV import validates identity, quoting and required labels', () => {
  const parsed = parseNativeDiscoveryCsv(`channel_id,country,language,trading_relevant,discovered,country_match,language_match,quality,community,provider
c1,France,fr,true,true,true,true,true,false,youtube-search
c2,France,fr,yes,no,,,,,youtube-innertube
c3,Germany,de,maybe,true,,,,,
`);
  assert.equal(parsed.labels.length, 2);
  assert.equal(parsed.skippedRows, 1);
  assert.equal(parsed.labels[0].channelId, 'c1');
  assert.equal(parsed.labels[0].quality, true);
  assert.equal(parsed.labels[1].discovered, false);
  assert.equal(parsed.labels[1].quality, null, 'missing optional labels stay unmeasured');
  assert.throws(() => parseNativeDiscoveryCsv('country,language\nFrance,fr'), /NATIVE_DISCOVERY_CSV_MISSING_COLUMN/);
});

test('CSV import rejects quoted fields, shifted columns and invalid identities', () => {
  const header = 'channel_id,country,language,trading_relevant,discovered';
  assert.throws(
    () => parseNativeDiscoveryCsv(`${header}\nc1,France,fr,"true",true`),
    /NATIVE_DISCOVERY_CSV_QUOTED_ROW:2/,
  );
  assert.throws(
    () => parseNativeDiscoveryCsv(`${header}\nc1,France,fr,true`),
    /NATIVE_DISCOVERY_CSV_COLUMN_COUNT:2/,
  );
  assert.throws(
    () => parseNativeDiscoveryCsv(`${header}\n,France,fr,true,true`),
    /NATIVE_DISCOVERY_CSV_EMPTY_CHANNEL:2/,
  );
  assert.throws(
    () => parseNativeDiscoveryCsv(`${header}\nc1,France,fr,true,true\nc1,France,fr,true,true`),
    /NATIVE_DISCOVERY_CSV_DUPLICATE_CHANNEL:3:c1/,
  );
});
