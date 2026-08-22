import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

test('normal run-cycle forwards request identity without accepting provider overrides', () => {
  const server = here('../server.ts');
  assert.match(server, /runAutonomousDiscoveryCycle\(country, providerTargetRequested \? \{[\s\S]*?\} : undefined, req\.requestId\)/);
  assert.match(server, /if \(providerTargetRequested\) \{[\s\S]*?providerKey !== 'brave-search'/);
});

test('producer persists a structured diagnostic report alongside the compatible queuedCount summary', () => {
  const source = here('./autonomousDiscovery.ts');
  assert.match(source, /diagnostics:\s*DiscoveryCycleDiagnostics/);
  assert.match(source, /scheduleAutonomousQueryRuns\(\[[\s\S]*?onDiagnostic: patch => recordCandidateDiagnostic/);
  assert.match(source, /queuedCount: scheduled\.length[\s\S]*?diagnostics/);
  assert.match(source, /candidateAttempts\+\+/);
});

test('scheduler exposes distinct operation labels and never passes query text to diagnostics', () => {
  const db = here('./db.ts');
  for (const operation of ['provider_registry_eligibility', 'query_run_insert', 'child_job_insert', 'query_run_job_linkage', 'decision_event_persistence']) {
    assert.match(db, new RegExp(operation));
  }
  const telemetry = here('./discoveryTelemetry.ts');
  assert.doesNotMatch(telemetry, /queryText|query:\s|token|secret|payload/i);
});

test('observability bridge has no migration or control-policy wiring', () => {
  const source = here('./autonomousDiscovery.ts');
  assert.doesNotMatch(source, /frontier_allocation_enabled\s*=|DISCOVERY_TARGET_QUEUE_DEPTH\s*=|enable.*frontier/i);
  assert.doesNotMatch(readFileSync(fileURLToPath(new URL('./discoveryTelemetry.ts', import.meta.url)), 'utf8'), /ALTER TABLE|CREATE TABLE|DROP TABLE|TRUNCATE/i);
});
