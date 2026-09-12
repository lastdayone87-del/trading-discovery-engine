import assert from 'node:assert/strict';
import test from 'node:test';
import { failedAttemptFinalizeQuery } from './db';

test('captured attempt row is finalized by id, never by open-row sweep', () => {
  const query = failedAttemptFinalizeQuery('job-1', 'attempt-row-A', 'boom');
  assert.match(query.text, /WHERE id=\$2 AND finished_at IS NULL/);
  assert.ok(!query.text.includes('job_id'), 'must not match sibling open rows');
  assert.deepEqual(query.values, ['boom', 'attempt-row-A']);
});

test('missing capture falls back to the legacy job-scoped filter', () => {
  for (const missing of [null, undefined, '']) {
    const query = failedAttemptFinalizeQuery('job-1', missing, 'boom');
    assert.match(query.text, /WHERE job_id=\$2 AND finished_at IS NULL/);
    assert.deepEqual(query.values, ['boom', 'job-1']);
  }
});

test('interleaving: a post-transition claim keeps its open row', () => {
  // Simulates failJob capturing attempt A, publishing PENDING, a new worker
  // claiming (opening B), then finalization running for A. Row-state
  // transitions mirror the UPDATE semantics above.
  type Row = { id: string; open: boolean };
  const rows: Row[] = [{ id: 'A', open: true }];
  const captured = 'A';
  rows.push({ id: 'B', open: true }); // new claim lands before finalization
  const query = failedAttemptFinalizeQuery('job-1', captured, 'boom');
  // The id-targeted UPDATE can only touch A, regardless of B's presence.
  for (const row of rows) {
    const matches =
      query.text.includes('WHERE id=$2') && row.id === query.values[1] && row.open;
    if (matches) row.open = false;
  }
  assert.equal(rows.find(row => row.id === 'A')?.open, false);
  assert.equal(
    rows.find(row => row.id === 'B')?.open,
    true,
    'the new claim’s row must survive finalization of the failed execution',
  );
});
