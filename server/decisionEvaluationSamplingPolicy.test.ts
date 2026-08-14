import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDecisionEvaluationSamplingPolicy } from './decisionEvaluationSamplingPolicy';

test('sampling policy is disabled when deployment salt is missing or blank', () => {
  assert.equal(buildDecisionEvaluationSamplingPolicy(undefined), null);
  assert.equal(buildDecisionEvaluationSamplingPolicy(''), null);
  assert.equal(buildDecisionEvaluationSamplingPolicy('   '), null);
});

test('sampling policy is valid when deployment salt is configured', () => {
  assert.deepEqual(buildDecisionEvaluationSamplingPolicy(' railway-prod-salt '), {
    policyKey: 'protected-audit',
    version: 1,
    salt: 'railway-prod-salt',
    protectedAuditBasisPoints: 100,
    targetedAuditBasisPoints: 0,
  });
});
