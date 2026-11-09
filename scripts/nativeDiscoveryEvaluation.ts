/**
 * Read-only native-discovery evaluation.
 *
 * Usage:
 *   npx tsx scripts/nativeDiscoveryEvaluation.ts <labelled.csv>
 *
 * The CSV header must include:
 *   channel_id,country,language,trading_relevant,discovered
 * Optional:
 *   country_match,language_match,quality,community,provider
 *
 * No database, provider or production write is performed.
 */
import { readFileSync } from 'node:fs';
import { evaluateNativeDiscovery, parseNativeDiscoveryCsv } from '../server/measurement/nativeDiscoveryMetrics';

const path = process.argv[2];
if (!path) {
  console.error('Usage: tsx scripts/nativeDiscoveryEvaluation.ts <labelled.csv>');
  process.exit(2);
}
const labels = parseNativeDiscoveryCsv(readFileSync(path, 'utf8'));
const report = evaluateNativeDiscovery({
  labels,
  providerYield: [],
});
const pct = (value: number | null) => value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
const interval = (metric: { rate: number | null; lower95: number | null; upper95: number | null }) =>
  metric.rate === null ? 'n/a' : `${pct(metric.rate)} (95% CI ${pct(metric.lower95)}–${pct(metric.upper95)})`;

console.log(`Native discovery evaluation — ${report.generatedAt}`);
console.log(`Labels: ${report.overall.sampleSize}; relevant in sample: ${report.overall.relevantInSample}; discovered: ${report.overall.discovered}`);
console.log(`Precision: ${interval(report.overall.precision)}`);
console.log(`Recall:    ${interval(report.overall.recall)}`);
console.log(`Country:   ${interval(report.overall.countryRelevance)}`);
console.log(`Language:  ${interval(report.overall.languageMatch)}`);
console.log(`False positive rate: ${interval(report.overall.falsePositiveRate)}`);
console.log(`Meets 90% lower bound on precision and recall: ${report.evidence.meets90PercentLowerBound}`);
if (report.evidence.marketsBelowRecommendedSample.length) {
  console.log(`Markets below the recommended ${report.evidence.recommendedLabelsPerMarket}-label sample: ${report.evidence.marketsBelowRecommendedSample.join(', ')}`);
}
