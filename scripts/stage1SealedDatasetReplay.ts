import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { evaluateStage1SealedDatasetReplay } from '../server/candidateAdmission/stage1SealedDatasetReplay';

async function latestSealedDatasetId(): Promise<string> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined });
  const db = await pool.connect();
  try {
    await db.query('BEGIN TRANSACTION READ ONLY');
    const result = await db.query(`SELECT id FROM decision_evaluation_datasets ORDER BY cutoff_at DESC, version DESC, id DESC LIMIT 1`);
    await db.query('ROLLBACK');
    if (!result.rowCount) throw new Error('NO_SEALED_EVALUATION_DATASET');
    return String(result.rows[0].id);
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}

const datasetId = process.env.STAGE1_DATASET_ID || await latestSealedDatasetId();
const report = await evaluateStage1SealedDatasetReplay(datasetId);
await mkdir('stage1-output', { recursive: true });
await writeFile('stage1-output/stage1-sealed-labeled-cohort-replay.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ datasetId, totals: report.totals, metrics: report.metrics }, null, 2));
