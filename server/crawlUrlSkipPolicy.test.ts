import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPPED_DETERMINISTIC_FAILURE_CLASSES,
  URL_SKIP_CONSECUTIVE_FAILURE_THRESHOLD,
  normalizeSkipUrl,
  skippedUrlsFromHistory,
  trailingIdenticalFailure,
  type UrlFailureRow,
} from './crawlUrlSkipPolicy';

function row(url: string, failureClass: string | null, outcome: string, dayOffset: number): UrlFailureRow {
  return {
    requestedUrl: url,
    failureClass,
    outcome,
    observedAt: new Date(Date.UTC(2026, 8, 10 - dayOffset, 12)).toISOString(),
  };
}

test('exactly five consecutive identical capped failures skip; four do not', () => {
  const five = Array.from({ length: 5 }, (_, index) => row('https://dead.example/', 'HTTP_ERROR', 'ACQUISITION_FAILED', 5 - index));
  assert.deepEqual(trailingIdenticalFailure(five), { failureClass: 'HTTP_ERROR', count: 5 });
  assert.ok(skippedUrlsFromHistory(five).has('https://dead.example/'));
  const four = five.slice(1);
  assert.deepEqual(trailingIdenticalFailure(four), { failureClass: 'HTTP_ERROR', count: 4 });
  assert.ok(!skippedUrlsFromHistory(four).has('https://dead.example/'));
});

test('any non-failed or different-class observation resets the sequence', () => {
  const recovered: UrlFailureRow[] = [
    row('https://flaky.example/', 'HTTP_ERROR', 'ACQUISITION_FAILED', 0),
    row('https://flaky.example/', 'HTTP_ERROR', 'ACQUISITION_FAILED', 1),
    row('https://flaky.example/', null, 'INSPECTED_NO_MATCH', 2),
    ...Array.from({ length: 9 }, (_, index) =>
      row('https://flaky.example/', 'HTTP_ERROR', 'ACQUISITION_FAILED', 3 + index)),
  ];
  assert.deepEqual(trailingIdenticalFailure(recovered), { failureClass: 'HTTP_ERROR', count: 2 });
  assert.ok(!skippedUrlsFromHistory(recovered).has('https://flaky.example/'));
  const drifted = [
    ...Array.from({ length: 6 }, (_, index) =>
      row('https://drift.example/', 'NETWORK_FAILURE', 'ACQUISITION_FAILED', 1 + index)),
    row('https://drift.example/', 'HTTP_ERROR', 'ACQUISITION_FAILED', 0),
  ];
  assert.deepEqual(trailingIdenticalFailure(drifted), { failureClass: 'HTTP_ERROR', count: 1 });
  const skipped = skippedUrlsFromHistory(drifted);
  assert.ok(!skipped.has('https://drift.example/'));
  const partial: UrlFailureRow[] = [
    ...Array.from({ length: 6 }, (_, index) =>
      ({ ...row('https://part.example/', 'HTTP_ERROR', 'PARTIALLY_INSPECTED', index - 5) })),
    ...Array.from({ length: 6 }, (_, index) =>
      row('https://part.example/', 'HTTP_ERROR', 'ACQUISITION_FAILED', 1 + index)),
  ];
  assert.equal(trailingIdenticalFailure(partial), undefined);
});

test('all four deterministic classes cap; budget/timeout/rate/transient never do', () => {
  for (const failureClass of CAPPED_DETERMINISTIC_FAILURE_CLASSES) {
    const rows = Array.from({ length: 7 }, (_, index) => row('https://x.example/', failureClass, 'ACQUISITION_FAILED', 7 - index));
    assert.ok(skippedUrlsFromHistory(rows).has('https://x.example/'), `${failureClass} must cap`);
  }
  for (const failureClass of ['RENDERED_BUDGET_EXPIRED', 'TIMEOUT', 'RATE_LIMIT', 'TRANSIENT_HTTP', 'ISOLATED_ACQUISITION_ERROR', 'RENDERED_TIMEOUT']) {
    const rows = Array.from({ length: 10 }, (_, index) => row('https://y.example/', failureClass, 'ACQUISITION_FAILED', 10 - index));
    assert.ok(!skippedUrlsFromHistory(rows).has('https://y.example/'), `${failureClass} must stay retryable`);
  }
});

test('skip evaluation is per-URL and normalizes seed forms', () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, index) => row('https://dead.example/', 'NETWORK_FAILURE', 'ACQUISITION_FAILED', 2 + index)),
    ...Array.from({ length: 2 }, (_, index) => row('https://live.example/', 'NETWORK_FAILURE', 'ACQUISITION_FAILED', 2 + index)),
    ...Array.from({ length: 2 }, (_, index) => row('https://live.example/', null, 'INSPECTED_NO_MATCH', 0 - index)),
  ];
  const skipped = skippedUrlsFromHistory(rows);
  assert.ok(skipped.has('https://dead.example/'));
  assert.ok(!skipped.has('https://live.example/'));
  assert.equal(normalizeSkipUrl('  example.com/x  '), 'https://example.com/x');
  assert.equal(normalizeSkipUrl(''), '');
});

test('threshold constant is five', () => {
  assert.equal(URL_SKIP_CONSECUTIVE_FAILURE_THRESHOLD, 5);
});

test('rendered zero-page echoes are transparent; pure runs still cap', () => {
  const mixed: UrlFailureRow[] = [
    row('https://mixed.example/', 'HTTP_ERROR', 'ACQUISITION_FAILED', 0),
    { ...row('https://mixed.example/', 'NO_PAGE_PROCESSED', 'ACQUISITION_FAILED', 1) },
    row('https://mixed.example/', 'HTTP_ERROR', 'ACQUISITION_FAILED', 2),
  ];
  assert.deepEqual(trailingIdenticalFailure(mixed), { failureClass: 'HTTP_ERROR', count: 2 });
  const pureZeroPage = Array.from({ length: 6 }, (_, index) =>
    row('https://walled.example/', 'NO_PAGE_PROCESSED', 'ACQUISITION_FAILED', 6 - index),
  );
  assert.deepEqual(trailingIdenticalFailure(pureZeroPage), { failureClass: 'NO_PAGE_PROCESSED', count: 6 });
  assert.ok(skippedUrlsFromHistory(pureZeroPage).has('https://walled.example/'));
});

test('leading zero-page run caps on its own; otherwise echoes stay transparent', () => {
  const leading = [
    ...Array.from({ length: 5 }, (_, index) =>
      row('https://echo.example/', 'NO_PAGE_PROCESSED', 'ACQUISITION_FAILED', 4 - index)),
    row('https://echo.example/', 'HTTP_ERROR', 'ACQUISITION_FAILED', 5),
  ];
  assert.deepEqual(trailingIdenticalFailure(leading), { failureClass: 'NO_PAGE_PROCESSED', count: 5 });
  assert.ok(skippedUrlsFromHistory(leading).has('https://echo.example/'));
  const short = [
    ...Array.from({ length: 2 }, (_, index) =>
      row('https://short.example/', 'NO_PAGE_PROCESSED', 'ACQUISITION_FAILED', 7 - index)),
    ...Array.from({ length: 6 }, (_, index) =>
      row('https://short.example/', 'HTTP_ERROR', 'ACQUISITION_FAILED', 6 - index)),
  ];
  assert.deepEqual(trailingIdenticalFailure(short), { failureClass: 'HTTP_ERROR', count: 6 });
});
