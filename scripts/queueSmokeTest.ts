import dotenv from 'dotenv';
dotenv.config();
import { enqueueJob, claimNextJob, completeJob, recoverStaleJobs } from '../server/db';

async function main() {
  const key = `queue-smoke-${Date.now()}`;
  const job = await enqueueJob('SMOKE_TEST', { key }, { idempotencyKey: key, maxAttempts: 2 });
  console.log('enqueued', job.id, job.status);
  const claimed = await claimNextJob('smoke-worker', ['SMOKE_TEST']);
  if (!claimed || claimed.id !== job.id) throw new Error('Failed to claim smoke-test job');
  console.log('claimed', claimed.id, claimed.status, claimed.attempts);
  await completeJob(claimed.id);
  const recovered = await recoverStaleJobs(0);
  console.log('completed', claimed.id, 'recoveredStale=', recovered);
}

main().catch(err => { console.error(err); process.exit(1); });
