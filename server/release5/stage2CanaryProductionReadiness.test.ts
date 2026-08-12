import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const script = fs.readFileSync(path.join(process.cwd(), 'scripts/stage2CanaryProductionReadiness.ts'), 'utf8');
const workflow = fs.readFileSync(path.join(process.cwd(), '.github/workflows/stage2-canary-production-readiness.yml'), 'utf8');
const migration = fs.readFileSync(path.join(process.cwd(), 'server/db/migrations/084_stage2_rate_pressure_canary_control_plane.sql'), 'utf8');

test('readiness requires migration 084 and persisted OFF mode', () => {
  assert.match(script, /version=84/);
  assert.match(script, /persistedModeOff: control\.mode === 'OFF'/);
  assert.match(migration, /mode TEXT NOT NULL DEFAULT 'OFF'/);
});

test('readiness fails if any treatment subject or prior enable event exists', () => {
  assert.match(script, /noCurrentGenerationTreatmentSubjects: currentGenerationTreatmentSubjects === 0/);
  assert.match(script, /noHistoricalCanaryEnableEvents: historicalCanaryEnableEvents === 0/);
});

test('readiness probe cannot activate production serving', () => {
  assert.match(script, /servingAuthority: false/);
  assert.match(script, /productionActivation: false/);
  assert.match(script, /mutatesCanaryControlState: false/);
  assert.doesNotMatch(script, /setStage2CanaryMode/);
});

test('production workflow is manual-only for database readiness', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /npm run migrate/);
  assert.match(workflow, /stage2CanaryProductionReadiness\.ts/);
  assert.doesNotMatch(script, /setStage2CanaryMode/);
});
