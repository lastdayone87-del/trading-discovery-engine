import assert from 'node:assert/strict';
import test from 'node:test';
import { failedAttemptFinalizeQuery, persistedJobFailureMessage } from './db';
import { ProviderCallError } from './providerResilience';
import { ProbeQuotaExceededError, YouTubeKeyCapUnavailableError } from './quotaKeyCapShadow';

test('structured failure codes are persisted in the attempt message', () => {
  const capUnavailable = new YouTubeKeyCapUnavailableError('YouTube key cap reservation lock timed out.');
  assert.equal(
    persistedJobFailureMessage(capUnavailable),
    'YOUTUBE_KEY_CAP_UNAVAILABLE: YouTube key cap reservation lock timed out.',
  );

  const probeQuota = new ProbeQuotaExceededError(
    '2026-10-26',
    9_000,
    100,
    9_000,
    new Date('2026-10-26T07:30:00.000Z'),
  );
  assert.equal(
    persistedJobFailureMessage(probeQuota),
    `QUOTA_ALLOCATION_EXHAUSTED: ${probeQuota.message}`,
  );

  // No code, an already-prefixed message, and the 2,000-character cap.
  assert.equal(persistedJobFailureMessage(new Error('plain failure')), 'plain failure');
  assert.equal(
    persistedJobFailureMessage(Object.assign(new Error('CODE: already prefixed'), { code: 'CODE' })),
    'CODE: already prefixed',
  );
  const long = Object.assign(new Error('x'.repeat(3_000)), { code: 'LONG' });
  const persisted = persistedJobFailureMessage(long);
  assert.equal(persisted.length, 2_000);
  assert.ok(!persisted.startsWith('LONG: '), 'unrelated codes keep the original prefix');

  // Community recovery matches this prefix exactly; a generic code prefix
  // would stop lease renewal and terminal reactivation.
  const deferral = Object.assign(
    new Error('Community acquisition deferred: browser capacity'),
    { code: 'BROWSER_RUNTIME_UNAVAILABLE' },
  );
  assert.equal(
    persistedJobFailureMessage(deferral),
    'Community acquisition deferred: browser capacity',
  );

  // executeProviderCall normalizes a YouTube quota error into a generic
  // message but retains the quota metadata; persist a countable marker.
  const wrappedProviderQuota = new ProviderCallError(
    'Provider rate limit reached.',
    'RATE_LIMIT',
    true,
    { status: 403, quotaExceeded: true, providerReasons: ['quotaExceeded'] },
  );
  assert.equal(
    persistedJobFailureMessage(wrappedProviderQuota),
    'YOUTUBE_QUOTA_EXCEEDED: Provider rate limit reached.',
  );
  const reasonOnly = Object.assign(
    new Error('Provider rate limit reached.'),
    { providerReasons: ['dailyLimitExceeded'] },
  );
  assert.equal(
    persistedJobFailureMessage(reasonOnly),
    'YOUTUBE_QUOTA_EXCEEDED: Provider rate limit reached.',
  );
});

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
