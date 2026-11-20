import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Read-only evaluation of the frozen full-classifier predictions against the
 * frozen truth file. This is the accepted relevance cohort; it is not a new
 * classifier run and cannot be used to tune the prompts.
 */
const truthPath = process.argv.find(arg => arg.startsWith('--truth='))?.split('=')[1]
  || fileURLToPath(new URL('../tests/fixtures/admission-v2/fresh_truth.json', import.meta.url));
const predictionsPath = process.argv.find(arg => arg.startsWith('--predictions='))?.split('=')[1]
  || fileURLToPath(new URL('../tests/fixtures/admission-v2/fresh_classifier.jsonl', import.meta.url));

const truth = JSON.parse(readFileSync(truthPath, 'utf8')) as Record<string, { relevance: string; content_type?: string }>;
const predictions = new Map<string, { label: string }>();
for (const line of readFileSync(predictionsPath, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const row = JSON.parse(line) as { id?: string | number; prediction?: { label?: string } };
  if (row.id !== undefined && row.prediction?.label) predictions.set(String(row.id), { label: row.prediction.label });
}

const RELEVANT = new Set(['ACTIVE_TRADING', 'TRADING_EDUCATION', 'INVESTING_EDUCATION', 'MARKET_INSTITUTION', 'HYPE']);
const FINANCE_ADJACENT = new Set(['FINANCIAL_NEWS', 'PERSONAL_FINANCE']);
const relevance = (label?: string) => label && RELEVANT.has(label) ? 'RELEVANT' : label && FINANCE_ADJACENT.has(label) ? 'ADJACENT' : 'UNRELATED';

const contentTypeAlias: Record<string, string> = { HYPE_PROMOTION: 'HYPE', SIGNAL_PROVIDER: 'HYPE', OTHER: 'OTHER' };
let total = 0;
let missingPredictions = 0;
let tp = 0, fp = 0, fn = 0, hardUnrelated = 0, contentTypeMatches = 0;
for (const [id, item] of Object.entries(truth)) {
  if (item.relevance === 'AMBIGUOUS') continue;
  const prediction = predictions.get(id);
  if (!prediction) {
    // An absent prediction is a miss for a relevant case, not an exclusion
    // that can silently inflate recall.
    missingPredictions += 1;
    total += 1;
    if (item.relevance === 'TRADING_RELEVANT') fn += 1;
    continue;
  }
  const predicted = prediction.label;
  total += 1;
  if (item.relevance === 'TRADING_RELEVANT' && relevance(predicted) === 'RELEVANT') tp += 1;
  if (item.relevance !== 'TRADING_RELEVANT' && relevance(predicted) === 'RELEVANT') fp += 1;
  if (item.relevance === 'TRADING_RELEVANT' && relevance(predicted) !== 'RELEVANT') fn += 1;
  if (item.relevance === 'UNRELATED' && relevance(predicted) === 'RELEVANT') hardUnrelated += 1;
  if (item.content_type && (contentTypeAlias[item.content_type] || item.content_type) === predicted) contentTypeMatches += 1;
}

console.log(JSON.stringify({
  total,
  precision: total ? tp / (tp + fp) : null,
  recall: total ? tp / (tp + fn) : null,
  truePositives: tp,
  falsePositives: fp,
  falseNegatives: fn,
  hardUnrelated,
  missingPredictions,
  hardUnrelatedRate: total ? hardUnrelated / total : null,
  contentTypeExact: total ? contentTypeMatches / total : null,
  truthPath,
  predictionsPath,
}, null, 2));
