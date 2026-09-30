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

test('ordering assignment is disabled by default and deterministic', () => {
  const a = selectOrderingExperimentArm('opp-1');
  assert.equal(a.arm, 'CONTROL');
  assert.equal(a.propensityBasisPoints, 10000);
  const b1 = selectOrderingExperimentArm('opp-1', 5000);
  const b2 = selectOrderingExperimentArm('opp-1', 5000);
  assert.deepEqual(b1, b2);
  assert.ok(b1.propensityBasisPoints === 5000 || b1.propensityBasisPoints === 5000);
  assert.throws(() => selectOrderingExperimentArm(''), /OPPORTUNITY_KEY_REQUIRED/);
  assert.throws(() => selectOrderingExperimentArm('opp', -1), /INVALID_TREATMENT/);
});
