import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWindowedSearchParams, selectOrderingExperimentArm } from './retrievalExperiment';

test('windowed params default to control passthrough', () => {
  const base = { q: 'DAX Analyse', order: 'relevance' };
  assert.deepEqual(buildWindowedSearchParams(base, null, null), { params: base, windowApplied: false, experimentId: null });
  assert.deepEqual(buildWindowedSearchParams(base, { publishedAfter: '2026-01-01T00:00:00Z' }, null).windowApplied, false);
});

test('windowed treatment requires valid range and experiment id', () => {
  const base = { q: 'x' };
  const treated = buildWindowedSearchParams(
    base,
    { publishedAfter: '2026-01-01T00:00:00Z', publishedBefore: '2026-02-01T00:00:00Z' },
    'exp-1',
  );
  assert.equal(treated.windowApplied, true);
  assert.equal(treated.params.publishedAfter, '2026-01-01T00:00:00Z');
  assert.throws(() => buildWindowedSearchParams(base, { publishedAfter: 'not-a-date' }, 'exp-1'), /INVALID_WINDOW/);
  assert.throws(
    () => buildWindowedSearchParams(base, { publishedAfter: '2026-02-01T00:00:00Z', publishedBefore: '2026-01-01T00:00:00Z' }, 'exp-1'),
    /EMPTY_RANGE/,
  );
});

test('windowed params enforce full-datetime RFC3339 with timezone', () => {
  const base = { q: 'x' };
  for (const valid of [
    '2026-01-01T00:00:00Z',
    '2026-06-15T12:30:45.123Z',
    '2026-01-01T00:00:00+02:00',
    '2026-01-01T00:00:00-05:30',
  ]) {
    const r = buildWindowedSearchParams(base, { publishedAfter: valid }, 'exp-1');
    assert.equal(r.windowApplied, true);
    assert.equal(r.params.publishedAfter, valid);
  }
  for (const invalid of ['2026-01-01', '2026-01-01 00:00:00', '2026-13-01T00:00:00Z', '2026-01-01T00:00:00', '2026-01-01T00:00:00+0200', '']) {
    assert.throws(() => buildWindowedSearchParams(base, { publishedAfter: invalid }, 'exp-1'), /INVALID_WINDOW_PUBLISHED_AFTER/, invalid || '(empty)');
  }
});

test('empty window with experiment id stays control passthrough', () => {
  const base = { q: 'x' };
  assert.deepEqual(buildWindowedSearchParams(base, {}, 'exp-1'), { params: base, windowApplied: false, experimentId: null });
  const single = buildWindowedSearchParams(base, { publishedBefore: '2026-02-01T00:00:00Z' }, 'exp-1');
  assert.equal(single.windowApplied, true);
  assert.equal(single.params.publishedBefore, '2026-02-01T00:00:00Z');
  assert.ok(!('publishedAfter' in single.params));
});

test('ordering assignment is disabled by default and deterministic', () => {
  const a = selectOrderingExperimentArm('opp-1');
  assert.equal(a.arm, 'CONTROL');
  assert.equal(a.propensityBasisPoints, 10000);
  const b1 = selectOrderingExperimentArm('opp-1', 5000);
  const b2 = selectOrderingExperimentArm('opp-1', 5000);
  assert.deepEqual(b1, b2);
  // Asymmetric allocation verifies the intended propensity relationship:
  // treatment arms carry the treatment basis points, control arms the complement.
  const c = selectOrderingExperimentArm('opp-propensity-probe', 2500);
  assert.equal(c.propensityBasisPoints, c.arm === 'TREATMENT' ? 2500 : 7500);
  assert.throws(() => selectOrderingExperimentArm(''), /OPPORTUNITY_KEY_REQUIRED/);
  assert.throws(() => selectOrderingExperimentArm('opp', -1), /INVALID_TREATMENT/);
});
