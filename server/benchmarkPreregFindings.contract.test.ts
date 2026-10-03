import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Greptile findings on PR #493 (benchmark preregistration): executable-path
// conformance for the frozen P2 window, pool/opportunity tracking, failed-run
// attribution, and P3 target-level shadow metrics. Contract tests only — no
// benchmark execution, no mechanism enablement, no UCB1 or frozen-parameter
// changes.

test('frozen P2 window derives from scheduled_at at schedule time', () => {
  const source = fs.readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  const scheduling = source.slice(
    source.indexOf('Frozen benchmark P2 path'),
    source.indexOf('const experimentMetadata = candidate.experiment')
  );
  assert.match(scheduling, /BENCHMARK_PREREG_ORDERING_EXPERIMENT_ID/);
  assert.match(scheduling, /deriveBenchmarkOrderingWindow\(scheduleTimestamp\)/);
  assert.match(scheduling, /arm === 'TREATMENT'/);
  // Caller-supplied or selection-time bounds are overwritten, never merged.
  assert.match(scheduling, /window: deriveBenchmarkOrderingWindow\(scheduleTimestamp\)/);
});

test('terminally failed runs receive a zero-funnel accounting attribution', () => {
  const source = fs.readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  const failure = source.slice(
    source.indexOf('export async function failQueryRun'),
    source.indexOf('export async function tryReserveQuota')
  );
  assert.match(failure, /INSERT INTO query_run_accounting_attributions/);
  assert.match(failure, /'query-run-accounting-v1'/);
  assert.match(failure, /ON CONFLICT\(query_run_id\) DO NOTHING/);
  assert.match(failure, /failureKind/);
  // Production counters are untouched: UCB1/Thompson observe completed runs
  // only, so the attribution row must not feed query_library aggregates.
  assert.doesNotMatch(failure, /times_executed=times_executed\+1/);
  assert.doesNotMatch(failure, /quality_channels_found=quality_channels_found\+\$|quality_channels_found \+/);
});

test('benchmark opportunity identity is stable per served query', async () => {
  const { benchmarkOpportunityIdFor } = await import('./querySelectionExperiments');
  // Same pool row retried maps to the same opportunity identity, so frozen
  // pool rows track 1:1 to opportunities while each attempt keeps its own
  // recorded assignment draw.
  assert.equal(benchmarkOpportunityIdFor('benchmark-prereg-v1-selection', 101), 'benchmark-prereg-v1:q101');
  assert.equal(benchmarkOpportunityIdFor('benchmark-prereg-v1-selection', 101), 'benchmark-prereg-v1:q101');
  assert.equal(benchmarkOpportunityIdFor('unrelated-exp', 101), undefined);
});
