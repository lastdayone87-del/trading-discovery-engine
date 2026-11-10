/**
 * Seed the human-verified evaluation dataset from a reviewed fixture.
 *
 * Usage:
 *   npx tsx scripts/seedHumanEvaluation.ts            # dry-run metrics
 *   npx tsx scripts/seedHumanEvaluation.ts --apply    # upsert samples
 *
 * The fixture labels are independent human assessments. system_prediction is
 * recorded for comparison only and is never used as the label.
 */
import { readFileSync } from 'node:fs';
import { getDb } from '../server/db';
import { computeEvaluationMetrics } from '../server/intakeDeferredReview';

interface SeedSample {
  sampleKey: string;
  channelId: string;
  channelName: string;
  youtubeUrl: string;
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
}

const fixturePath = new URL('../server/fixtures/humanEvaluationSeed.json', import.meta.url);
const samples = JSON.parse(readFileSync(fixturePath, 'utf8')) as SeedSample[];
const metrics = computeEvaluationMetrics(samples.map(sample => ({
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
})));
console.log(JSON.stringify({ samples: samples.length, metrics }, null, 2));

if (!process.argv.includes('--apply')) {
  console.log('Dry run. Re-run with --apply to upsert into human_evaluation_samples.');
  process.exit(0);
}

const db = await getDb();
let written = 0;
for (const sample of samples) {
  await db.query(
    `INSERT INTO human_evaluation_samples(
       sample_key,channel_id,stratum,system_status,system_prediction,human_label,
       human_confidence,language,country,metadata_quality,evidence_snapshot,reviewer,notes,decided_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,now())
     ON CONFLICT(sample_key) DO UPDATE SET
       stratum=excluded.stratum,system_status=excluded.system_status,
       system_prediction=excluded.system_prediction,human_label=excluded.human_label,
       human_confidence=excluded.human_confidence,language=excluded.language,
       country=excluded.country,metadata_quality=excluded.metadata_quality,
       evidence_snapshot=excluded.evidence_snapshot,reviewer=excluded.reviewer,
       notes=excluded.notes`,
    [
      sample.sampleKey, sample.channelId, sample.stratum, sample.systemStatus,
      sample.systemPrediction, sample.humanLabel, sample.humanConfidence,
      sample.language, sample.country, sample.metadataQuality,
      JSON.stringify({ ...sample.evidence, channelName: sample.channelName, youtubeUrl: sample.youtubeUrl }),
      sample.reviewer, sample.notes,
    ],
  );
  written += 1;
}
console.log(`Upserted ${written} human-evaluation samples.`);
process.exit(0);
