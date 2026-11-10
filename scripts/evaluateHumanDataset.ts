/**
 * Offline evaluation of the human-verified dataset fixture.
 *
 * Reports overall precision/recall/FPR/FNR and breakdowns by language, country,
 * and metadata quality. Ambiguous human labels and system abstentions are
 * reported separately, never forced into the binary confusion matrix.
 */
import { readFileSync } from 'node:fs';
import {
  computeEvaluationBreakdown,
  computeEvaluationMetrics,
  type HumanEvaluationSample,
} from '../server/intakeDeferredReview';

const samples = JSON.parse(readFileSync(new URL('../server/fixtures/humanEvaluationSeed.json', import.meta.url), 'utf8')) as Array<{
  sampleKey: string;
  channelId: string;
  stratum: string;
  systemStatus: string | null;
  systemPrediction: 'TRADING' | 'NON_TRADING' | 'ABSTAIN';
  humanLabel: 'TRADING' | 'NON_TRADING' | 'AMBIGUOUS';
  humanConfidence: 'HIGH' | 'MEDIUM' | 'LOW';
  language: string;
  country: string;
  metadataQuality: string;
  evidence: Record<string, unknown>;
  reviewer: string;
  notes: string;
}>;

const normalized: HumanEvaluationSample[] = samples.map(sample => ({
  sampleKey: sample.sampleKey,
  channelId: sample.channelId,
  stratum: sample.stratum,
  systemStatus: sample.systemStatus,
  systemPrediction: sample.systemPrediction,
  humanLabel: sample.humanLabel,
  humanConfidence: sample.humanConfidence,
  language: sample.language,
  country: sample.country,
  metadataQuality: sample.metadataQuality,
  evidenceSnapshot: sample.evidence,
  reviewer: sample.reviewer,
  notes: sample.notes,
  decidedAt: '2026-11-10T00:00:00.000Z',
}));

console.log(JSON.stringify({
  sampleSize: normalized.length,
  overall: computeEvaluationMetrics(normalized),
  byLanguage: computeEvaluationBreakdown(normalized, 'language'),
  byCountry: computeEvaluationBreakdown(normalized, 'country'),
  byMetadataQuality: computeEvaluationBreakdown(normalized, 'metadataQuality'),
}, null, 2));
