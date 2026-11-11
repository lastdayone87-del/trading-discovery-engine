/**
 * Seed the human-verified evaluation dataset from a reviewed fixture.
 *
 * Usage:
 *   npx tsx scripts/seedHumanEvaluation.ts            # dry-run metrics
 *   npx tsx scripts/seedHumanEvaluation.ts --apply    # upsert samples
 *
 * The fixture labels are independent human assessments. system_prediction is
 * recorded for comparison only and is never used as the label. The apply path
 * is transactional and writes the fixture's decidedAt timestamp, not the
 * script execution time.
 */
import { readFileSync } from 'node:fs';
import { getDb } from '../server/db';
import { computeEvaluationMetrics, normalizeHumanEvaluationSamples } from '../server/intakeDeferredReview';

const raw = JSON.parse(readFileSync(new URL('../server/fixtures/humanEvaluationSeed.json', import.meta.url), 'utf8'));
const samples = normalizeHumanEvaluationSamples(raw);
console.log(JSON.stringify({ samples: samples.length, metrics: computeEvaluationMetrics(samples) }, null, 2));

if (!process.argv.includes('--apply')) {
  console.log('Dry run. Re-run with --apply to upsert into human_evaluation_samples.');
  process.exit(0);
}

const db = await getDb();
const client = await db.connect();
try {
  await client.query('BEGIN');
  let written = 0;
  for (const sample of samples) {
    await client.query(
      `INSERT INTO human_evaluation_samples(
         sample_key,channel_id,stratum,system_status,system_prediction,human_label,
         human_confidence,language,country,metadata_quality,evidence_snapshot,reviewer,notes,decided_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)
       ON CONFLICT(sample_key) DO UPDATE SET
         stratum=excluded.stratum,system_status=excluded.system_status,
         system_prediction=excluded.system_prediction,human_label=excluded.human_label,
         human_confidence=excluded.human_confidence,language=excluded.language,
         country=excluded.country,metadata_quality=excluded.metadata_quality,
         evidence_snapshot=excluded.evidence_snapshot,reviewer=excluded.reviewer,
         notes=excluded.notes,decided_at=excluded.decided_at`,
      [
        sample.sampleKey, sample.channelId, sample.stratum, sample.systemStatus,
        sample.systemPrediction, sample.humanLabel, sample.humanConfidence,
        sample.language, sample.country, sample.metadataQuality,
        JSON.stringify(sample.evidenceSnapshot),
        sample.reviewer, sample.notes, sample.decidedAt,
      ],
    );
    written += 1;
  }
  await client.query('COMMIT');
  console.log(`Upserted ${written} human-evaluation samples.`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  client.release();
}
process.exit(0);
