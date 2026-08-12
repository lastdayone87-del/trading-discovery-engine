import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(process.cwd(), 'server/release5/stage2CanaryControlPlane.ts'), 'utf8');
const migration = fs.readFileSync(path.join(process.cwd(), 'server/db/migrations/084_stage2_rate_pressure_canary_control_plane.sql'), 'utf8');

test('control plane defaults the production kill switch to OFF', () => {
  assert.match(migration, /mode TEXT NOT NULL DEFAULT 'OFF'/);
  assert.match(migration, /VALUES \(TRUE, 'OFF'\)/);
  assert.match(source, /defaultMode: 'OFF'/);
});

test('treatment capacity is physically bounded to 50 unique slots per generation', () => {
  assert.match(migration, /treatment_slot SMALLINT NOT NULL CHECK \(treatment_slot BETWEEN 1 AND 50\)/);
  assert.match(migration, /UNIQUE \(canary_generation, treatment_slot\)/);
  assert.match(source, /maximumTreatmentSubjects/);
  assert.match(source, /pg_advisory_xact_lock/);
  assert.match(source, /FOR UPDATE/);
  assert.match(source, /canary_generation=\$1 AND t\.treatment_slot=s\.slot/);
});

test('canary cohorts are generation-scoped and restart-safe', () => {
  assert.match(migration, /PRIMARY KEY \(canary_generation, subject_key\)/);
  assert.match(source, /Number\(row\.generation\) !== canaryGeneration/);
  assert.match(source, /WHERE canary_generation=\$1 AND subject_key=\$2/);
});

test('enabling CANARY requires explicit manual approval and optimistic generation', () => {
  assert.match(source, /manualApproval: true/);
  assert.match(source, /MANUAL_OPERATOR_APPROVAL_REQUIRED/);
  assert.match(source, /STAGE2_CANARY_STALE_CONTROL_GENERATION/);
  assert.match(source, /automaticEnableForbidden: true/);
});

test('all subject evaluation remains non-serving in this implementation step', () => {
  const matches = source.match(/servingAuthority: false/g) ?? [];
  assert.ok(matches.length >= 3);
  assert.doesNotMatch(source, /servingAuthority:\s*true/);
});

test('human-confirmed genuine trading creator triggers immediate abort', () => {
  assert.match(source, /GENUINE_TRADING_CREATOR/);
  assert.match(source, /ANY_HUMAN_CONFIRMED_TRADING_CREATOR_WITHHELD/);
  assert.match(source, /return abortStage2Canary\('ANY_HUMAN_CONFIRMED_TRADING_CREATOR_WITHHELD'/);
});

test('missing evidence fails closed only after CANARY is confirmed active', () => {
  const modeCheck = source.indexOf("if (state.mode !== 'CANARY')");
  const evidenceCheck = source.indexOf("if (!evidenceSnapshotChecksum.trim())");
  assert.ok(modeCheck >= 0 && evidenceCheck > modeCheck);
  assert.match(source, /await abortStage2Canary\('REQUIRED_EVIDENCE_SNAPSHOT_MISSING'\)/);
});
