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
  assert.equal(report.overall.falsePositiveRate.rate, 1 / 4);
  assert.equal(report.byCountry.France.sampleSize, 8);
  assert.equal(report.byLanguage.fr.precision.rate, 3 / 4);
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
  const strong = evaluateNativeDiscovery({
    labels: Array.from({ length: 300 }, (_, index) => label({ channelId: `c${index}` })),
  });
  assert.equal(strong.evidence.meets90PercentLowerBound, true);
  assert.ok(strong.overall.precision.lower95! >= 0.9);
  assert.ok(strong.overall.recall.lower95! >= 0.9);
});

test('provider yield is reported per 100 requests with an interval', () => {
  const [yieldRow] = evaluateProviderYield([{ provider: 'youtube-innertube', requests: 100, newConfirmedCreators: 50 }]);
  assert.equal(yieldRow.newConfirmedPer100Requests, 50);
  assert.equal(yieldRow.interval.rate, 0.5);
  assert.ok(yieldRow.interval.lower95! < 0.5 && yieldRow.interval.upper95! > 0.5);
});

test('CSV import requires the identity and label columns and ignores malformed booleans', () => {
  const rows = parseNativeDiscoveryCsv(`channel_id,country,language,trading_relevant,discovered,country_match,language_match,quality,community,provider
c1,France,fr,true,true,true,true,true,false,youtube-search
c2,France,fr,yes,no,,,,,youtube-innertube
c3,Germany,de,maybe,true,,,,,
`);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].channelId, 'c1');
  assert.equal(rows[0].quality, true);
  assert.equal(rows[1].discovered, false);
  assert.throws(() => parseNativeDiscoveryCsv('country,language\nFrance,fr'), /NATIVE_DISCOVERY_CSV_MISSING_COLUMN/);
});
