import test from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_FIXTURES, ENGINE_FIXTURE_CORPUS_VERSION, validateEngineFixtures } from './engineFixtures';

test('fixture corpus is self-consistent and covers every required stratum', () => {
  assert.deepEqual(validateEngineFixtures(ENGINE_FIXTURES), [], 'corpus mechanics must hold before any scorer work');
  assert.match(ENGINE_FIXTURE_CORPUS_VERSION, /^engine-fixtures-v\d+$/);
});

test('blocked fixtures never masquerade as negatives', () => {
  const blocked = ENGINE_FIXTURES.filter(fixture => fixture.expectedOutcome === 'BLOCKED');
  assert.ok(blocked.length >= 2, 'login, WAF, and rate-limit coverage required');
  for (const fixture of blocked) {
    assert.notEqual(fixture.expectedOutcome, 'INSPECTED_NO_MATCH');
    assert.notEqual(fixture.expectedOutcome, 'NOT_FOUND' as never);
  }
});

test('adversarial fixtures pin precision: no evidence where none exists', () => {
  const adversarial = ENGINE_FIXTURES.filter(fixture => fixture.strata === 'known-negative-adversarial');
  assert.ok(adversarial.length >= 2);
  for (const fixture of adversarial) {
    assert.equal(fixture.expectedOutcome, 'INSPECTED_NO_MATCH');
  }
});

test('corpus validator rejects duplicates, open labels, and missing strata', () => {
  assert.ok(validateEngineFixtures([]).some(problem => problem.includes('stratum unrepresented')));
  assert.ok(
    validateEngineFixtures([...ENGINE_FIXTURES, { ...ENGINE_FIXTURES[0] }]).some(problem => problem.includes('duplicate')),
  );
  assert.ok(
    validateEngineFixtures(
      ENGINE_FIXTURES.map(fixture => ({ ...fixture, expectedOutcome: 'WHATEVER' as never })),
    ).some(problem => problem.includes('open outcome label')),
  );
});
