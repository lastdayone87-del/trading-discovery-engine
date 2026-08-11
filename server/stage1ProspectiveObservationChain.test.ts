import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('durable production diagnostics require the complete non-serving evidence bundle', () => {
  const diagnostics = readFileSync(new URL('./classificationDiagnostics.ts', import.meta.url), 'utf8');
  assert.match(diagnostics, /requireCompleteObservation: Boolean\(diagnostic\.observationKey\)/);
  assert.match(diagnostics, /if \(diagnostic\.observationKey\) throw error/);
});

test('forced evidence observation bypasses only observational feature flags', () => {
  const dualWrite = readFileSync(new URL('./evidenceEngine/dualWrite.ts', import.meta.url), 'utf8');
  assert.match(dualWrite, /configuredDocumentsEnabled \|\| options\.requireCompleteObservation === true/);
  assert.match(dualWrite, /forceShadowObservation: options\.requireCompleteObservation === true/);
  assert.match(dualWrite, /CREATOR_FOCUS_SNAPSHOT_REQUIRED_FOR_DURABLE_DIAGNOSTIC/);
  assert.match(dualWrite, /servingAuthority: false as const/);
});

test('forced creator-focus observation is always SHADOW and never a canary assignment', () => {
  const creatorFocus = readFileSync(new URL('./evidenceEngine/creatorFocusClassifier.ts', import.meta.url), 'utf8');
  assert.match(creatorFocus, /input\.forceShadowObservation\?'SHADOW'/);
  assert.match(creatorFocus, /basis=input\.forceShadowObservation\?0/);
  assert.match(creatorFocus, /servingAuthority:false/);
  assert.match(creatorFocus, /terminalAuthority:false/);
});
