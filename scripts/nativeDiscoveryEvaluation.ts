/**
 * Read-only native-discovery evaluation.
 *
 * Usage:
 *   npx tsx scripts/nativeDiscoveryEvaluation.ts <labelled.csv> [provider-requests.json]
 *
 * The CSV header must include:
 *   channel_id,country,language,trading_relevant,discovered
 * Optional:
 *   country_match,language_match,quality,community,provider
 *
 * The optional provider-requests JSON is an array of:
 *   { "provider": string, "requests": number, "newConfirmedCreators": number }
 *
 * No database, provider or production write is performed.
 */
import { readFileSync } from 'node:fs';
import {
  evaluateNativeDiscovery,
  parseNativeDiscoveryCsv,
  type ProviderYieldInput,
} from '../server/measurement/nativeDiscoveryMetrics';

const path = process.argv[2];
if (!path) {
  console.error('Usage: tsx scripts/nativeDiscoveryEvaluation.ts <labelled.csv> [provider-requests.json]');
  process.exit(2);
}
const parsed = parseNativeDiscoveryCsv(readFileSync(path, 'utf8'));
const providerPath = process.argv[3];
let providerYield: ProviderYieldInput[] | undefined;
if (providerPath) {
  const raw = JSON.parse(readFileSync(providerPath, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('NATIVE_DISCOVERY_PROVIDER_YIELD_NOT_ARRAY');
  providerYield = raw.map((row: Record<string, unknown>, index: number) => {
    const provider = typeof row?.provider === 'string' ? row.provider.trim() : '';
    const requests = Number(row?.requests);
    const newConfirmedCreators = Number(row?.newConfirmedCreators);
    if (!provider || !Number.isFinite(requests) || requests < 0 || !Number.isFinite(newConfirmedCreators) || newConfirmedCreators < 0) {
      throw new Error(`NATIVE_DISCOVERY_PROVIDER_YIELD_MALFORMED:${index + 1}`);
    }
    return { provider, requests, newConfirmedCreators };
  });
}
const report = evaluateNativeDiscovery({ labels: parsed.labels, providerYield });
const pct = (value: number | null) => value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
const interval = (metric: { rate: number | null; lower95: number | null; upper95: number | null }) =>
  metric.rate === null ? 'n/a' : `${pct(metric.rate)} (95% CI ${pct(metric.lower95)}–${pct(metric.upper95)})`;

console.log(`Native discovery evaluation — ${report.generatedAt}`);
console.log(`Labels: ${report.overall.sampleSize}; skipped malformed rows: ${parsed.skippedRows}; relevant in sample: ${report.overall.relevantInSample}; discovered: ${report.overall.discovered}`);
console.log(`Precision: ${interval(report.overall.precision)}`);
console.log(`Recall:    ${interval(report.overall.recall)}`);
console.log(`Country:   ${interval(report.overall.countryRelevance)}`);
console.log(`Language:  ${interval(report.overall.languageMatch)}`);
console.log(`Quality:   ${interval(report.overall.qualityYield)}`);
console.log(`Community: ${interval(report.overall.communityYield)}`);
console.log(`False positive rate: ${interval(report.overall.falsePositiveRate)}`);
console.log(`Meets 90% lower bound on precision and recall (overall and every reported market): ${report.evidence.meets90PercentLowerBound}`);
if (report.evidence.marketsBelowRecommendedSample.length) {
  console.log(`Markets below the recommended ${report.evidence.recommendedLabelsPerMarket}-label sample: ${report.evidence.marketsBelowRecommendedSample.join(', ')}`);
}
for (const [heading, groups] of [['By country', report.byCountry], ['By language', report.byLanguage]] as const) {
  console.log(`${heading}:`);
  if (!Object.keys(groups).length) {
    console.log('  (none)');
    continue;
  }
  for (const [name, metrics] of Object.entries(groups)) {
    console.log(`  ${name}: labels=${metrics.sampleSize}; precision=${interval(metrics.precision)}; recall=${interval(metrics.recall)}`);
  }
}
if (providerYield) {
  console.log('Provider yield:');
  if (!report.providerYield.length) console.log('  (none)');
  for (const row of report.providerYield) {
    console.log(`  ${row.provider}: ${row.newConfirmedCreators}/${row.requests} = ${row.newConfirmedPer100Requests.toFixed(1)} new confirmed creators per 100 requests`);
  }
} else {
  console.log('Provider yield: not provided (pass a provider-requests JSON file to include it)');
}
