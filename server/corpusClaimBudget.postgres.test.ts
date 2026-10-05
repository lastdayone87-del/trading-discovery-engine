import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

/**
 * Concurrency regression for atomic budget admission (ClaimBudgetGuard):
 * concurrent guarded claims must never admit past the daily budget, and
 * denied jobs must stay PENDING (never FAILED) for the next window.
 * Requires DATABASE_URL (CI secret); skipped otherwise. Cleans up all rows
 * it creates and restores the control row it constrains.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const maybe = enabled ? test : test.skip;

maybe('concurrent budget-guarded claims admit at most remaining headroom', async t => {
  const { getDb, enqueueJob, claimNextJob } = await import('./dbCore');
  const { TERM_HARVEST_BUDGET_GUARD, SCORE_CANDIDATES_BUDGET_GUARD } = await import('./queueManager');
  assert.deepEqual(SCORE_CANDIDATES_BUDGET_GUARD.types, ['SCORE_CANDIDATES']);
  const db = await getDb();
  const tag = `budget-race:${Date.now()}:${process.pid}`;
  const prev = (await db.query(
    'SELECT paused, daily_compute_documents FROM corpus_controls WHERE singleton=true'
  )).rows[0];
  const jobIds: string[] = [];
  try {
    // Constrain to a budget of exactly 1 with the control open.
    await db.query(
      `UPDATE corpus_controls SET paused=false, daily_compute_documents=1 WHERE singleton=true`
    );
    for (let index = 0; index < 3; index++) {
      const text = `budget race probe ${tag} ${index}`;
      const job = await enqueueJob(
        'TERM_HARVEST',
        {
          payloadSchemaVersion: 1,
          channelId: 'UCbudgetrace00000000000000',
          text,
          contentHash: createHash('sha256').update(text.normalize('NFC')).digest('hex'),
          lineage: 'AUTONOMOUS',
          entityClusterKey: `budget-race-${tag}`,
          observedAt: new Date().toISOString(),
          extractorVersion: 'deterministic-ngram-v1',
        },
        { priority: 5, maxAttempts: 3, idempotencyKey: `test-budget-race:${tag}:${index}` }
      );
      jobIds.push(job.id);
    }
    // Three concurrent guarded claims against a budget of 1: exactly one may
    // be admitted (row-lock serialization + in-flight counting); the rest
    // return null with their jobs still PENDING, attempts untouched.
    const results = await Promise.all(
      [0, 1, 2].map(n =>
        claimNextJob(`test-budget-race-${n}`, ['TERM_HARVEST'], undefined, undefined, [
          TERM_HARVEST_BUDGET_GUARD,
        ])
      )
    );
    const claimed = results.filter(Boolean);
    assert.equal(claimed.length, 1);
    const states = (
      await db.query('SELECT status, attempts FROM jobs WHERE id = ANY($1::uuid[])', [jobIds])
    ).rows as Array<{ status: string; attempts: number }>;
    assert.equal(states.filter(row => row.status === 'PROCESSING').length, 1);
    assert.equal(states.filter(row => row.status === 'PENDING').length, 2);
    assert.ok(states.every(row => row.status !== 'FAILED'));
    assert.ok(
      states.filter(row => row.status === 'PENDING').every(row => Number(row.attempts) === 0),
      'denied jobs must not consume attempts'
    );
  } finally {
    if (jobIds.length > 0) {
      await db
        .query('DELETE FROM jobs WHERE id = ANY($1::uuid[])', [jobIds])
        .catch(() => undefined);
    }
    await db
      .query('UPDATE corpus_controls SET paused=$1, daily_compute_documents=$2 WHERE singleton=true', [
        prev.paused,
        prev.daily_compute_documents,
      ])
      .catch(() => undefined);
  }
});
