/**
 * Offline evaluation of the human-verified dataset fixture.
 *
 * Reports overall precision/recall/FPR/FNR and breakdowns by language, country,
 * and metadata quality. Ambiguous human labels and system abstentions are
 * reported separately, never forced into the binary confusion matrix.
 *
 * The fixture is validated at runtime so a typo in an enum cannot silently
 * disappear from one side of the matrix.
 */
import { readFileSync } from 'node:fs';
import {
  computeEvaluationBreakdown,
  computeEvaluationMetrics,
  normalizeHumanEvaluationSamples,
} from '../server/intakeDeferredReview';

const raw = JSON.parse(readFileSync(new URL('../server/fixtures/humanEvaluationSeed.json', import.meta.url), 'utf8'));
const samples = normalizeHumanEvaluationSamples(raw);

console.log(JSON.stringify({
  sampleSize: samples.length,
  overall: computeEvaluationMetrics(samples),
  byLanguage: computeEvaluationBreakdown(samples, 'language'),
  byCountry: computeEvaluationBreakdown(samples, 'country'),
  byMetadataQuality: computeEvaluationBreakdown(samples, 'metadataQuality'),
}, null, 2));
