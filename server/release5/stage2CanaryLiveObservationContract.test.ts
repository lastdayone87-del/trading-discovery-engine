import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync('.github/workflows/stage2-live-canary-observation.yml', 'utf8');
const script = fs.readFileSync('scripts/stage2CanaryLiveObservation.ts', 'utf8');

test('live observer runs hourly or manually only from main production context', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /cron: '17 \* \* \* \*'/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment: production/);
  assert.doesNotMatch(workflow, /\bpush:/);
});

test('PR runs verify only and cannot execute production observer', () => {
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'schedule'/);
});

test('observer uses the validated rate-pressure policy and bounded control plane', () => {
  assert.match(script, /applyStage2RatePressureShadowPolicy/);
  assert.match(script, /evaluateOfflineAdmissionV2/);
  assert.match(script, /evaluateStage2CanarySubject/);
  assert.match(script, /ratePressureFallbackApplied === true/);
  assert.match(script, /originalDecision === 'DEFER_INVESTIGATION'/);
  assert.match(script, /pressured\.decision === 'WITHHOLD'/);
});

test('observer does not gain serving authority or mutate channel classification', () => {
  assert.match(script, /servingAuthority: false/);
  assert.match(script, /productionMutation: false/);
  assert.doesNotMatch(script, /upsertChannel/);
  assert.doesNotMatch(script, /inspectAndValidateChannel/);
  assert.doesNotMatch(script, /setStage2CanaryMode\('CANARY'/);
});

test('human outcomes come only from reserved treatment subjects and existing review decisions', () => {
  assert.match(script, /FROM stage2_rate_pressure_canary_subjects s/);
  assert.match(script, /channel_review_decisions r/);
  assert.match(script, /r\.decision IN\('APPROVE','REJECT'\)/);
  assert.match(script, /recordStage2CanaryHumanOutcome/);
});

test('observation clock starts from first treatment reservation, not idle activation', () => {
  assert.match(script, /event_type='TREATMENT_RESERVED'/);
  assert.match(script, /observationClockStartsAtFirstTreatmentReservation: true/);
  assert.match(script, /minimumObservationWindowHours/);
  assert.match(script, /minimumHumanAdjudicatedTreatmentOutcomes/);
  assert.match(script, /minimumConfirmedNonTradingPrecision/);
});
