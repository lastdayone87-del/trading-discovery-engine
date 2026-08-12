import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync('.github/workflows/stage2-manual-canary-activation.yml', 'utf8');
const script = fs.readFileSync('scripts/stage2ManualCanaryActivation.ts', 'utf8');

test('activation workflow is manual-only and main-only', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\bpush:/);
  assert.doesNotMatch(workflow, /\bschedule:/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
});

test('activation requires exact typed authorization and production environment', () => {
  assert.match(workflow, /AUTHORIZE_STAGE2_5_PERCENT_CANARY_MAX_50/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /STAGE2_CANARY_EXPECTED_GENERATION/);
});

test('activation script fails closed on state and generation and only enables CANARY', () => {
  assert.match(script, /before\.mode !== 'OFF'/);
  assert.match(script, /before\.generation !== expectedGeneration/);
  assert.match(script, /setStage2CanaryMode\('CANARY'/);
  assert.match(script, /manualApproval: true/);
  assert.doesNotMatch(script, /setStage2CanaryMode\('ON'/);
});

test('activation record fixes the bounded envelope and forbids automatic ramp', () => {
  assert.match(script, /allocationBasisPoints: 500/);
  assert.match(script, /allocationPercent: 5/);
  assert.match(script, /maximumTreatmentSubjects: 50/);
  assert.match(script, /automaticRampForbidden: true/);
});
