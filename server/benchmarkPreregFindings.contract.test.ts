import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Greptile findings on PR #493 (benchmark preregistration): executable-path
// conformance for the frozen P2 window, pool/opportunity tracking, failed-run
// attribution, and P3 target-level shadow metrics. Contract tests only — no
// benchmark execution, no mechanism enablement, no UCB1 or frozen-parameter
// changes.

test('schedule derives the frozen window from the stored scheduled_at', () => {
  const source = fs.readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  // The authoritative timestamp comes from the run record, not an app clock.
  assert.match(source, /RETURNING id, scheduled_at/);
  const frozenBlock = source.slice(
    source.indexOf('const frozenPatched = resolveFrozenBenchmarkScheduleOrdering'),
    source.indexOf('const orderingWindow = candidate.experiment')
  );
  assert.match(frozenBlock, /new Date\(String\(run\.rows\[0\]\.scheduled_at\)\)/);
  assert.match(frozenBlock, /experimentMetadata = \{ selectionExperiment: candidate\.experiment \}/);
  assert.match(frozenBlock, /jsonb_set\(jsonb_set\(metadata, '\{selectionExperiment,ordering,window\}'/);
  // No independent application timestamp feeds the frozen derivation.
  assert.doesNotMatch(frozenBlock, /new Date\(\)/);
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
  // Status and attribution commit atomically: no crash window can strand a
  // terminal run without its accounting row.
  assert.match(failure, /await client\.query\('BEGIN'\)/);
  assert.match(failure, /await client\.query\('COMMIT'\)/);
  // Production counters are untouched: UCB1/Thompson observe completed runs
  // only, so the attribution row must not feed query_library aggregates.
  assert.doesNotMatch(failure, /times_executed=times_executed\+1/);
  assert.doesNotMatch(failure, /quality_channels_found=quality_channels_found\+\$|quality_channels_found \+/);
});

test('already-terminal failQueryRun still reaches observation capture without mutating', () => {
  const source = fs.readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  const failure = source.slice(
    source.indexOf('export async function failQueryRun'),
    source.indexOf('export async function tryReserveQuota')
  );
  // The already-terminal branch rolls back and falls through — it must not
  // return before the capture step, or a later call could never recover an
  // observation missed by an earlier capture failure. Scope both assertions
  // to the terminal branch body itself: the wider range reaching the catch
  // block contains a second ROLLBACK that must not satisfy this check.
  assert.match(failure, /if \(!run\.rowCount\)/);
  const terminalBranch = failure.slice(failure.indexOf('if (!run.rowCount)'));
  const terminalBody = terminalBranch.slice(0, terminalBranch.indexOf('} else {'));
  assert.match(terminalBody, /ROLLBACK/);
  assert.doesNotMatch(terminalBody, /return;/);
  // Capture runs after the client is released, so it is reachable from both
  // the mutated and the already-terminal paths, and stays best-effort.
  assert.ok(failure.indexOf('client.release()') < failure.indexOf('captureCompletedRunObservation'));
  assert.match(failure, /captureCompletedRunObservation\(runId\)\.catch\(/);
  // All four mutations live exclusively in the mutated (else) branch: the
  // terminal path writes nothing and the attribution row is inserted exactly
  // once.
  assert.match(failure, /if \(!run\.rowCount\)[\s\S]*\} else \{[\s\S]*INSERT INTO query_run_accounting_attributions/);
  assert.equal(failure.match(/INSERT INTO query_run_accounting_attributions/g)?.length, 1);
  const mutatedBranch = failure.slice(failure.indexOf('} else {'), failure.indexOf('} catch (error)'));
  for (const required of [
    'UPDATE query_library SET reserved_at=NULL',
    "UPDATE quota_reservations SET status='RELEASED'",
    'INSERT INTO query_run_accounting_attributions',
    "await client.query('COMMIT')",
  ]) {
    assert.ok(mutatedBranch.includes(required), `mutated branch must contain: ${required}`);
  }
});

test('benchmark opportunity identity is designated pre-selection, never served-query derived', async () => {
  const { benchmarkOpportunityIdForScope, isFrozenBenchmarkConfiguration, normalizeSelectionExperimentRequest } = await import('./querySelectionExperiments');
  const frozen = normalizeSelectionExperimentRequest({
    selection: { experimentId: 'benchmark-prereg-v1-selection', enabledArms: ['THOMPSON', 'CONTEXTUAL'], treatmentBasisPoints: 5000 },
    ordering: { experimentId: 'benchmark-prereg-v1-ordering', treatmentBasisPoints: 5000 },
    benchmark: { snapshotHash: 'abc123', poolRowId: 101 },
  });
  // The designated frozen pool row maps stably regardless of arm, attempt,
  // or which query wins; retries stay attached to the same opportunity.
  assert.equal(benchmarkOpportunityIdForScope(frozen.benchmark, 101, frozen), 'benchmark-prereg-v1:pool:abc123:101');
  // A fallback winner, a newly generated query, or any non-designated row
  // never acquires the frozen identity.
  assert.equal(benchmarkOpportunityIdForScope(frozen.benchmark, 102, frozen), undefined);
  assert.equal(benchmarkOpportunityIdForScope(null, 101, frozen), undefined);
  assert.equal(benchmarkOpportunityIdForScope(undefined, 101, frozen), undefined);
  // A valid scope alone never grants benchmark identity: the request must
  // exactly match the frozen benchmark configuration.
  const offConfig = normalizeSelectionExperimentRequest({
    selection: { experimentId: 'other-exp', enabledArms: ['THOMPSON'], treatmentBasisPoints: 5000 },
    benchmark: { snapshotHash: 'abc123', poolRowId: 101 },
  });
  assert.equal(isFrozenBenchmarkConfiguration(offConfig), false);
  assert.equal(benchmarkOpportunityIdForScope(offConfig.benchmark, 101, offConfig), undefined);
  // The scope rides the validated request shape (pre-selection by design).
  const source = fs.readFileSync(new URL('./querySelectionExperiments.ts', import.meta.url), 'utf8');
  assert.match(source, /benchmark\?: SelectionExperimentBenchmarkScope/);
  assert.match(source, /INVALID_BENCHMARK_SCOPE/);
  assert.match(source, /isFrozenBenchmarkConfiguration\(experiment\)/);
});

test('benchmark cycles serve only the designated row and read back before scheduling', () => {
  const cycle = fs.readFileSync(new URL('./autonomousDiscovery.ts', import.meta.url), 'utf8');
  // Research/frontier/native allocations are declined under benchmark scope.
  assert.match(cycle, /!normalizedExperiment\?\.benchmark/);
  assert.match(cycle, /Benchmark-designated attempt declines non-designated allocation/);
  // Arms choose freely; the output gate declines non-designated selections
  // before scheduling (never forced, never generated for the benchmark).
  assert.match(cycle, /selected\.queryRecord\.id !== normalizedExperiment\.benchmark\.poolRowId/);
  assert.match(cycle, /reasonCode: 'SELECTED_ANOTHER_QUERY'/);
  const experiments = fs.readFileSync(new URL('./querySelectionExperiments.ts', import.meta.url), 'utf8');
  // Selection pools are NOT pre-restricted: Thompson/Contextual/UCB1 choose
  // among eligible queries with full production gates.
  assert.doesNotMatch(experiments, /restrictPoolToDesignatedRow/);
  const intelligence = fs.readFileSync(new URL('./queryIntelligence.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(intelligence, /restrictToQueryIds/);
});

test('plan enforces the full frozen scope and execution waits for terminal attribution', () => {
  const script = fs.readFileSync(new URL('../scripts/runBenchmarkPreregV1.ts', import.meta.url), 'utf8');
  assert.match(script, /assertFullScope\(snapshot, spec\)/);
  assert.match(script, /--execute --spec-version=\$\{spec\.specVersion\} --out/);
  assert.match(script, /requireFreshPlanForStatus\(record\.status, snapshot\.collectedAt\)/);
  assert.ok(
    script.indexOf('requireFreshPlanForStatus(record.status, snapshot.collectedAt)') <
      script.indexOf("record.status = 'IN_PROGRESS'"),
    'freshness must read the original persisted status before IN_PROGRESS mutation'
  );
  assert.match(script, /const requestId = `\$\{spec\.logTag\}:/);
  assert.match(script, /\$\{spec\.logTag\}\] INCOMPLETE:/);
  assert.ok(!script.includes('benchmark-prereg-v2:${'), 'no hardcoded v2 request namespace may remain');
  assert.ok(script.includes('--execute --spec-version=v2 --out'), 'documented execute command must select v2');
  assert.ok(script.includes('--plan --spec-version=v2 --out'), 'documented plan command must select v2');
  assert.match(script, /isSchedulerStoppedForBenchmark\(/);
  assert.match(script, /waitForTerminalObservation\(pollRunState\(/);
  assert.match(script, /isScopeTerminallyAccounted\(/);
  assert.match(script, /planRowAttempt\(\{/);
  assert.match(script, /detectConfigurationDrift\(/);
  assert.match(script, /record\.firstObservedAt/);
});

test('cycle throw adopts ledger-matched runs; unreadable ledger aborts instead of excluding', () => {
  const script = fs.readFileSync(new URL('../scripts/runBenchmarkPreregV1.ts', import.meta.url), 'utf8');
  // A failed release strands nothing silently: genuinely stranded RESERVED
  // decisions abort the run as an infra incident.
  assert.match(script, /BENCHMARK_ALLOCATION_RELEASE_FAILED/);
  assert.match(script, /INFRA_INCIDENT:LEDGER_UNREADABLE/);
  // No silent empty-list fallback on ledger read failure.
  assert.doesNotMatch(script, /readMatched\(designated\.benchmarkOpportunityId, attemptStart\.toISOString\(\)\)\.catch\(\(\) => \[\]\)/);
});

test('failed benchmark allocation release fails closed only when still reserved', () => {
  const source = fs.readFileSync(new URL('./autonomousDiscovery.ts', import.meta.url), 'utf8');
  // A benign race (decision already consumed elsewhere) proceeds; only a
  // still-RESERVED decision with held quota fails the cycle.
  assert.match(source, /SELECT decision_status FROM frontier_allocation_decisions WHERE decision_id = \$1/);
  assert.match(source, /BENCHMARK_ALLOCATION_RELEASE_FAILED/);
});
