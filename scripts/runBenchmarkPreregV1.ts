/**
 * Version-parameterized execution runner (default: benchmark-preregistration-v1).
 *
 * Sole authority is the active spec document: docs/BENCHMARK_PREREGISTRATION.md
 * for v1, docs/BENCHMARK_PREREGISTRATION_V2.md for --spec-version=v2. This script is NOT a
 * new benchmark and shares nothing with fastBenchmark, evaluateBenchmark,
 * semantic benchmarks, or any other script: those are different benchmarks
 * and must never be substituted here.
 *
 * Modes (no benchmark observations are created unless --execute is passed):
 * - plan (default): read-only against the database. Verifies frozen
 *   versions and gates, exports the deterministic 120-row pool snapshot +
 *   hash, captures configuration/provider/migration provenance, and writes
 *   pool-snapshot.json + execution-record.json (status PLANNED). Schedules
 *   nothing. This is the only mode used during implementation.
 * - --execute: carries out the frozen execution row by row through the
 *   existing runAutonomousDiscoveryCycle path (untouched engine), one
 *   designated attempt per pool row, with wall-clock/quota/kill-switch
 *   ceilings and per-attempt ledger read-back. Do NOT run without explicit
 *   review approval.
 *
 * Usage:
 *   npx tsx scripts/runBenchmarkPreregV1.ts --plan --spec-version=v2 --out ./benchmark-prereg-v2
 *   npx tsx scripts/runBenchmarkPreregV1.ts --execute --spec-version=v2 --out ./benchmark-prereg-v2
 */
import dotenv from 'dotenv';
import { parseBenchmarkArgs } from '../server/benchmarkPreregCli';
dotenv.config();
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../server/db';
import { rowToQuery } from '../server/dbCore';
import {
  BENCHMARK_PREREG_FROZEN_MIGRATION_COUNT,
  BENCHMARK_PREREG_V2_SPEC,
  benchmarkPreregSpecForVersion,
  isSameUtcDayPlan,
  requireFreshPlanForStatus,
  assertExecutionPreflightReady,
  isSchedulerStoppedForBenchmark,
  verifyFrozenBenchmarkVersions,
  verifyBenchmarkGatesOff,
  buildFrozenBenchmarkRequest,
  buildPoolSnapshot,
  verifyPoolSnapshotHash,
  verifyExecutionArtifactsBound,
  assertFullScope,
  computeConfigurationHash,
  buildExecutionRecord,
  classifyNoMatchOutcome,
  waitForTerminalObservation,
  detectConfigurationDrift,
  benchmarkDeadlineMs,
  isWallClockExceeded,
  planRowAttempt,
  isBenchmarkRowTerminal,
  isScopeTerminallyAccounted,
  type BenchmarkExecutionRecord,
  type BenchmarkRowState,
  type PoolSnapshot,
} from '../server/benchmarkPreregV1';
import {
  assertBenchmarkPlannedQueueDepth,
  assertBenchmarkQueueDepthEstablished,
  benchmarkValidatedQueueDepth,
} from '../server/benchmarkCapacityGuard';

function usageError(message: string): never {
  console.error(`[benchmark-prereg] ${message}`);
  console.error('Usage: npx tsx scripts/runBenchmarkPreregV1.ts [--plan|--execute] --out <dir> [--force] [--spec-version=v1|v2]');
  process.exit(1);
}

function parseArgs(argv: string[]): { mode: 'plan' | 'execute'; outDir: string; force: boolean; specVersion: string } {
  try {
    return parseBenchmarkArgs(argv);
  } catch (error) {
    usageError(error instanceof Error ? error.message.replace(/^BENCHMARK_PREREG_USAGE: /, '') : String(error));
  }
}

function runningCommit(repoRoot: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    throw new Error('BENCHMARK_PREREG_PROVENANCE_UNAVAILABLE: git rev-parse HEAD failed');
  }
}

function effectiveNumberedSetting(
  settings: Record<string, string>,
  key: string,
  envKey: string,
  fallback: string,
  min: number,
  max: number = Number.POSITIVE_INFINITY
): number {
  // Same precedence as production readers (app_settings ?? env ?? fallback)
  // with the engine's bounds: cooldown is clamped to 1..10080 like
  // numericSetting('query_intelligence_query_cooldown_minutes', ..., 360, 1,
  // 10080) in runAutonomousDiscoveryCycle; other numbered settings keep only
  // their lower bound like queryIntelligence/querySelectionExperiments.
  const raw = settings[key] ?? process.env[envKey] ?? fallback;
  const parsed = Number(raw) || Number(fallback);
  const finite = Number.isFinite(parsed) ? parsed : Number(fallback);
  return Math.min(max, Math.max(min, finite));
}

async function main(): Promise<void> {
  const { mode, outDir, force, specVersion } = parseArgs(process.argv.slice(2));
  const spec = benchmarkPreregSpecForVersion(specVersion);
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const commit = runningCommit(repoRoot);
  console.log(`[${spec.logTag}] mode=${mode} spec=${spec.specVersion} frozenBase=${spec.baseCommit} running=${commit}`);

  // Fail closed on any frozen drift before touching anything else.
  verifyFrozenBenchmarkVersions();

  const db = await getDb();
  const settingsRows = (await db.query('SELECT setting_key, setting_value FROM app_settings ORDER BY setting_key')).rows as Array<{ setting_key: string; setting_value: string }>;
  const settings: Record<string, string> = Object.fromEntries(settingsRows.map(row => [row.setting_key, row.setting_value]));
  verifyBenchmarkGatesOff(settings);

  // Capacity-record guard (non-frozen enforcement for the frozen 15-vs-30
  // divergence; see docs/operations-capacity-defaults.md). No plan may be
  // created unless the record will evidence queue depth 30 via an explicit
  // database/environment value. Fails before any snapshot query or file.
  assertBenchmarkQueueDepthEstablished(settings, process.env, 'plan');

  const migrationRows = (await db.query('SELECT max(version) AS max_version FROM schema_migrations')).rows as Array<{ max_version: string | number | null }>;
  const maxMigrationVersion = Number(migrationRows[0]?.max_version || 0);
  if (maxMigrationVersion < BENCHMARK_PREREG_FROZEN_MIGRATION_COUNT) {
    throw new Error(`BENCHMARK_PREREG_MIGRATIONS_BEHIND: max=${maxMigrationVersion} required>=${BENCHMARK_PREREG_FROZEN_MIGRATION_COUNT}`);
  }

  const recordPath = join(outDir, 'execution-record.json');
  const snapshotPath = join(outDir, 'pool-snapshot.json');

  if (mode === 'plan') {
    if (!force && (existsSync(recordPath) || existsSync(snapshotPath))) {
      throw new Error('BENCHMARK_PREREG_RECORD_EXISTS: refusing to overwrite; pass --force to re-plan before any observation');
    }
    const libraryRows = (await db.query('SELECT * FROM query_library ORDER BY id')).rows as Array<Record<string, unknown>>;
    const now = new Date();
    const cooldownMinutes = effectiveNumberedSetting(settings, 'query_intelligence_query_cooldown_minutes', 'QUERY_INTELLIGENCE_COOLDOWN_MINUTES', '360', 1, 10080);
    const maxPrimaryUses = effectiveNumberedSetting(settings, 'query_intelligence_primary_term_max_uses', 'QUERY_INTELLIGENCE_PRIMARY_TERM_MAX_USES', '2', 1);
    const snapshot = buildPoolSnapshot({
      rows: libraryRows.map(row => rowToQuery(row)),
      collectedAt: now,
      cooldownMinutes,
      maxPrimaryUses,
    }, spec);
    if (snapshot.rows.length === 0) {
      throw new Error('BENCHMARK_PREREG_EMPTY_POOL: no eligible opportunities; refusing to freeze an empty scope');
    }
    // Frozen scope (per active spec): an undersized plan is not executable
    // and must fail closed here with its deterministic reason, never silently fewer.
    assertFullScope(snapshot, spec);
    const providerRegistry = (await db.query(
      'SELECT provider_key, provider_family, provider_kind, capabilities, quota_domain, mode, daily_cost_cap, configuration_version FROM discovery_provider_registry ORDER BY provider_key'
    )).rows as Array<Record<string, unknown>>;
    const configurationHash = computeConfigurationHash({ appSettings: settingsRows, maxMigrationVersion, providerRegistry });
    const record = buildExecutionRecord({ runningCommit: commit, poolSnapshot: snapshot, configurationHash, maxMigrationVersion, providerRegistry, appSettings: settingsRows, spec });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`[${spec.logTag}] PLANNED rows=${snapshot.rows.length}/${snapshot.candidateRows} hash=${snapshot.snapshotHash}`);
    console.log(`[${spec.logTag}] configHash=${configurationHash} out=${outDir}`);
    console.log(`[${spec.logTag}] Execute ONLY with explicit approval: npx tsx scripts/runBenchmarkPreregV1.ts --execute --spec-version=${spec.specVersion} --out ${outDir}`);
    await db.end().catch(() => undefined);
    return;
  }

  // --execute: frozen execution through the untouched engine path.
  if (!existsSync(recordPath) || !existsSync(snapshotPath)) {
    throw new Error('BENCHMARK_PREREG_NO_PLAN: run --plan first; refusing to execute without a frozen snapshot + record');
  }
  const record = JSON.parse(readFileSync(recordPath, 'utf8')) as BenchmarkExecutionRecord;
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as PoolSnapshot;
  const recordSpec = benchmarkPreregSpecForVersion(record.specVersion);
  if (
    recordSpec.specVersion !== spec.specVersion ||
    record.frozenBaseCommit !== recordSpec.baseCommit ||
    record.poolSnapshot.snapshotHash !== snapshot.snapshotHash ||
    (record.status !== 'PLANNED' && record.status !== 'IN_PROGRESS')
  ) {
    throw new Error('BENCHMARK_PREREG_RECORD_MISMATCH: execution record does not match the frozen plan and requested spec version; refusing to execute');
  }
  verifyPoolSnapshotHash(snapshot);
  verifyExecutionArtifactsBound(record, snapshot);
  // All initial-execution preflight (freshness + scheduler quiescence)
  // must pass BEFORE the record is mutated and persisted as IN_PROGRESS.
  // Otherwise a failed gate would leave a fresh PLANNED record converted to
  // IN_PROGRESS, letting a later execution resume against a stale snapshot
  // and bypass the same-day requirement.
  const { runAutonomousDiscoveryCycle, getAutonomousDiscoveryStatus } = await import('../server/autonomousDiscovery');
  const status = await getAutonomousDiscoveryStatus().catch(() => null);
  const schedulerRow = (await db.query(`SELECT is_enabled, is_running FROM scheduler_state WHERE name='autonomous_discovery'`).catch(() => ({ rows: [] })) as { rows: Array<{ is_enabled: boolean; is_running: boolean }> }).rows[0];
  assertExecutionPreflightReady({
    recordStatus: record.status,
    collectedAtIso: snapshot.collectedAt,
    schedulerRow,
    liveRunning: status?.isRunning === true,
  });
  if (status?.isRunning) {
    throw new Error('BENCHMARK_PREREG_SCHEDULER_BUSY: autonomous scheduler already running; stop it before executing');
  }
  // Capacity-record enforcement for execution: the live environment must
  // evidence 30 AND the plan file itself must record 30 (a pre-guard plan
  // with a fallback-governed 15 must never execute). Both checks run before
  // the record mutates to IN_PROGRESS. The validated depth is captured here
  // and pinned into every discovery cycle below, so a database change after
  // this point cannot divert the run while the record stays valid.
  const validatedQueueDepth = benchmarkValidatedQueueDepth(settings, process.env, 'execute');
  assertBenchmarkPlannedQueueDepth(record.plannedKnobs, 'execute');
  record.status = 'IN_PROGRESS';
  record.runningCommit = commit;
  if (record.firstObservedAt === undefined) record.firstObservedAt = null;
  // Persist IN_PROGRESS only after all preflight passed, and before any
  // scheduling, so a post-scheduling crash or ledger-read failure can never
  // leave the file as PLANNED while a run is active. Every later mutation
  // also saves via saveRecord().
  record.updatedAt = new Date().toISOString();
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  if (record.firstObservedAt === undefined) record.firstObservedAt = null;

  const saveRecord = () => {
    record.updatedAt = new Date().toISOString();
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  };
  const rowState = (benchmarkOpportunityId: string): BenchmarkRowState => {
    const attempts = (record.attempts as Array<{ benchmarkOpportunityId?: string; state?: BenchmarkRowState }>)
      .filter(attempt => attempt.benchmarkOpportunityId === benchmarkOpportunityId);
    if (attempts.length === 0) return 'NOT_ATTEMPTED';
    return attempts[attempts.length - 1].state || 'NOT_ATTEMPTED';
  };
  const readMatched = async (benchmarkOpportunityId: string, sinceIso: string) => (await db.query(
    `SELECT id, query_id, status, scheduled_at FROM query_runs
     WHERE metadata->'selectionExperiment'->>'benchmarkOpportunityId' = $1 AND scheduled_at >= $2
     ORDER BY scheduled_at`,
    [benchmarkOpportunityId, sinceIso]
  )).rows as Array<{ id: string; query_id: number; status: string; scheduled_at: string }>;
  const abortIncomplete = async (stopReason: string): Promise<never> => {
    record.status = 'INCOMPLETE';
    record.stopReason = stopReason;
    saveRecord();
    await db.end().catch(() => undefined);
    throw new Error(`[${spec.logTag}] INCOMPLETE: ${stopReason}`);
  };
  const pollRunState = (runId: string) => async () => {
    const runRows = (await db.query('SELECT status, completed_at FROM query_runs WHERE id = $1', [runId])).rows as Array<{ status: string; completed_at: string | null }>;
    const attrRows = await db.query('SELECT 1 FROM query_run_accounting_attributions WHERE query_run_id = $1', [runId]);
    const completedAt = runRows[0]?.completed_at ? new Date(String(runRows[0].completed_at)).toISOString() : null;
    return { status: String(runRows[0]?.status || 'UNKNOWN'), attributed: (attrRows.rowCount || 0) > 0, completedAt };
  };
  const haltedByKillSwitch = async (): Promise<boolean> => {
    const paused = (await db.query("SELECT setting_value FROM app_settings WHERE setting_key = 'query_intelligence_paused'")).rows as Array<{ setting_value: string }>;
    return (paused[0]?.setting_value ?? 'false') === 'true';
  };

  for (const designated of record.designatedOpportunities) {
    let preMatched: Array<{ id: string; query_id: number; status: string; scheduled_at: string }>;
    try {
      preMatched = await readMatched(designated.benchmarkOpportunityId, record.createdAt);
    } catch (readError) {
      await abortIncomplete(`INFRA_INCIDENT:LEDGER_UNREADABLE:${(readError instanceof Error ? readError.message : String(readError)).slice(0, 120)}`);
    }
    const rowPlan = planRowAttempt({
      covered: isBenchmarkRowTerminal(rowState(designated.benchmarkOpportunityId)),
      matchedRunIds: preMatched.map(run => run.id),
    });
    if (rowPlan === 'skip-covered') continue;

    // Re-verify frozen provenance at this durable execution boundary. Any
    // drift fails closed: schedule nothing further under a changed config.
    const liveSettingsRows = (await db.query('SELECT setting_key, setting_value FROM app_settings ORDER BY setting_key')).rows as Array<{ setting_key: string; setting_value: string }>;
    const liveSettings: Record<string, string> = Object.fromEntries(liveSettingsRows.map(row => [row.setting_key, row.setting_value]));
    const liveRegistry = (await db.query(
      'SELECT provider_key, provider_family, provider_kind, capabilities, quota_domain, mode, daily_cost_cap, configuration_version FROM discovery_provider_registry ORDER BY provider_key'
    )).rows as Array<Record<string, unknown>>;
    const liveMigration = Number(((await db.query('SELECT max(version) AS max_version FROM schema_migrations')).rows as Array<{ max_version: string | number | null }>)[0]?.max_version || 0);
    if (!record.plannedKnobs) {
      await abortIncomplete('CONFIGURATION_DRIFT:planned knob baseline absent from execution record');
    }
    const drift = detectConfigurationDrift(
      { knobs: record.plannedKnobs, providerRegistry: record.providerRegistry, maxMigrationVersion: record.maxMigrationVersion },
      { settings: liveSettings, providerRegistry: liveRegistry, maxMigrationVersion: liveMigration }
    );
    if (drift.length > 0) {
      await abortIncomplete(`CONFIGURATION_DRIFT:${drift.join(';').slice(0, 400)}`);
    }
    if (isWallClockExceeded(Date.now(), record.firstObservedAt, record.createdAt)) {
      await abortIncomplete('WALL_CLOCK_CEILING');
    }
    const deadlineMs = benchmarkDeadlineMs(record.firstObservedAt, record.createdAt);
    const observeRun = async (runId: string): Promise<'OBSERVED_COMPLETE' | 'OBSERVED_FAILED'> => {
      try {
        return await waitForTerminalObservation(pollRunState(runId), {
          deadlineMs,
          pollIntervalMs: 60_000,
          isHalted: haltedByKillSwitch,
        });
      } catch (error) {
        if (error instanceof Error && /KILL_SWITCH/.test(error.message)) await abortIncomplete('KILL_SWITCH_PAUSED');
        if (error instanceof Error && /WALL_CLOCK_CEILING/.test(error.message)) await abortIncomplete('WALL_CLOCK_CEILING');
        throw error;
      }
    };

    if (rowPlan === 'adopt-recovered') {
      // A previous attempt scheduled this run but the process was
      // interrupted before recording it: adopt the durable ledger state and
      // wait it out. Never schedule a duplicate for the same opportunity.
      const latest = preMatched[preMatched.length - 1];
      if (!record.firstObservedAt) {
        record.firstObservedAt = preMatched.map(run => run.scheduled_at).sort()[0];
        saveRecord();
      }
      const outcome = await observeRun(latest.id);
      record.attempts.push({
        benchmarkOpportunityId: designated.benchmarkOpportunityId, poolRowId: designated.poolRowId,
        country: designated.country, state: outcome, recovered: true,
        matchedRunIds: preMatched.map(run => run.id),
      });
      saveRecord();
      console.log(`[${spec.logTag}] recovered ${designated.benchmarkOpportunityId} ${outcome} run=${latest.id}`);
      continue;
    }

    // rowPlan === 'schedule-attempt': zero matched runs exist; invoke exactly
    // one cycle. Free choice with the SELECTED_ANOTHER_QUERY output gate
    // guarantees it schedules the designated row or nothing — never
    // unrelated work.
    const attemptStart = new Date();
    const requestId = `${spec.logTag}:${snapshot.snapshotHash.slice(0, 12)}:${designated.poolRowId}`;
    // Kill-switch recheck immediately before scheduling: drift checking ran
    // above, but a pause engaged in the gap must still stop the benchmark.
    // The engine also honors pause for benchmark scope even with a target
    // country; this runner-side check fails closed first. The read and the
    // abort are separate so no error-message regex drives control flow: only
    // a read failure becomes KILL_SWITCH_UNREADABLE, and the PAUSED abort's
    // own error is never caught here.
    let killSwitchEngaged: boolean;
    try {
      killSwitchEngaged = await haltedByKillSwitch();
    } catch (readError) {
      await abortIncomplete(`INFRA_INCIDENT:KILL_SWITCH_UNREADABLE:${(readError instanceof Error ? readError.message : String(readError)).slice(0, 120)}`);
    }
    if (killSwitchEngaged) {
      await abortIncomplete('KILL_SWITCH_PAUSED');
    }
    let report: {
      queuedCount?: number; remainingAutonomousQuota?: number; summary?: string; isPaused?: boolean;
      diagnostics?: { candidates?: Array<{ disposition?: string; reasonCode?: string }> };
    };
    try {
      const row = snapshot.rows.find(candidate => candidate.queryId === designated.poolRowId);
      if (!row) throw new Error(`BENCHMARK_PREREG_DESIGNATED_ROW_MISSING: poolRowId=${designated.poolRowId}`);
      const frozenRequest = buildFrozenBenchmarkRequest(snapshot.snapshotHash, row.queryId, spec);
      report = await runAutonomousDiscoveryCycle(row.country, undefined, requestId, frozenRequest, { pinnedTargetQueueDepth: validatedQueueDepth });
      // Engine pause (kill switch engaged mid-cycle) is an abort, never a
      // no-match exclusion: schedule nothing further.
      if (report.isPaused) {
        await abortIncomplete('KILL_SWITCH_PAUSED');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already in progress|already held|SCHEDULER_BUSY|BENCHMARK_ALLOCATION_RELEASE_FAILED/.test(message)) {
        await abortIncomplete(`INFRA_INCIDENT:${message.slice(0, 200)}`);
      }
      // The producer may have scheduled before throwing (e.g., post-commit
      // scheduler-state bookkeeping): read the durable ledger first. An
      // already-created run is adopted and awaited — never excluded while it
      // may yet produce an attributed observation, and never rescheduled.
      // A ledger read failure is itself an infra incident, never an empty
      // match list: abort rather than risk excluding a row whose run exists.
      let postMatched: Array<{ id: string; query_id: number; status: string; scheduled_at: string }>;
      try {
        postMatched = await readMatched(designated.benchmarkOpportunityId, attemptStart.toISOString());
      } catch (readError) {
        await abortIncomplete(`INFRA_INCIDENT:LEDGER_UNREADABLE:${(readError instanceof Error ? readError.message : String(readError)).slice(0, 120)}`);
      }
      if (postMatched.length > 0) {
        if (!record.firstObservedAt) {
          record.firstObservedAt = postMatched.map(run => run.scheduled_at).sort()[0];
          saveRecord();
        }
        const outcome = await observeRun(postMatched[postMatched.length - 1].id);
        record.attempts.push({
          benchmarkOpportunityId: designated.benchmarkOpportunityId, poolRowId: designated.poolRowId,
          country: designated.country, state: outcome, recovered: true,
          matchedRunIds: postMatched.map(run => run.id),
          note: `adopted-after-cycle-error:${message.slice(0, 120)}`,
        });
        saveRecord();
        console.log(`[${spec.logTag}] adopted ${designated.benchmarkOpportunityId} ${outcome} run=${postMatched[postMatched.length - 1].id}`);
        continue;
      }
      record.attempts.push({
        benchmarkOpportunityId: designated.benchmarkOpportunityId, poolRowId: designated.poolRowId,
        country: designated.country, state: 'EXCLUDED_EXECUTION_FAILURE', cycleRequestId: requestId,
        exclusionReason: `EXECUTION_FAILURE:${message.slice(0, 200)}`,
      });
      saveRecord();
      console.log(`[${spec.logTag}] excluded ${designated.benchmarkOpportunityId} EXCLUDED_EXECUTION_FAILURE`);
      continue;
    }
    const attemptEnd = new Date();
    // Post-scheduling ledger reads are durability boundaries: a failure here
    // must abort as an infra incident with INCOMPLETE persisted, never exit
    // uncaught and never masquerade as zero matches.
    let matched: Array<{ id: string; query_id: number; status: string; scheduled_at: string }>;
    let windowRuns: Array<{ id: string; boid: string | null }>;
    try {
      matched = await readMatched(designated.benchmarkOpportunityId, attemptStart.toISOString());
      windowRuns = ((await db.query(
        `SELECT id, metadata->'selectionExperiment'->>'benchmarkOpportunityId' AS boid FROM query_runs
         WHERE scheduled_at >= $1 AND scheduled_at < $2`,
        [attemptStart.toISOString(), attemptEnd.toISOString()]
      )).rows as Array<{ id: string; boid: string | null }>);
    } catch (readError) {
      await abortIncomplete(`INFRA_INCIDENT:LEDGER_UNREADABLE:${(readError instanceof Error ? readError.message : String(readError)).slice(0, 120)}`);
    }
    const extras = windowRuns.filter(run => run.boid !== designated.benchmarkOpportunityId);
    if (extras.length > 0) {
      record.extras.push({ afterOpportunity: designated.benchmarkOpportunityId, count: extras.length, runIds: extras.slice(0, 50).map(run => run.id) });
    }
    if (matched.length === 0) {
      const classified = classifyNoMatchOutcome({
        queuedCount: report.queuedCount,
        remainingAutonomousQuota: report.remainingAutonomousQuota,
        candidates: report.diagnostics?.candidates,
        extrasCount: extras.length,
      });
      record.attempts.push({
        benchmarkOpportunityId: designated.benchmarkOpportunityId, poolRowId: designated.poolRowId,
        country: designated.country, state: classified.state, cycleRequestId: requestId,
        exclusionReason: classified.reason, queuedCount: report.queuedCount || 0,
        remainingAutonomousQuota: report.remainingAutonomousQuota ?? null,
      });
      saveRecord();
      console.log(`[${spec.logTag}] excluded ${designated.benchmarkOpportunityId} ${classified.state} ${classified.reason}`);
    } else {
      if (!record.firstObservedAt) {
        record.firstObservedAt = matched.map(run => run.scheduled_at).sort()[0];
        saveRecord();
      }
      const outcome = await observeRun(matched[matched.length - 1].id);
      record.attempts.push({
        benchmarkOpportunityId: designated.benchmarkOpportunityId, poolRowId: designated.poolRowId,
        country: designated.country, state: outcome, cycleRequestId: requestId,
        matchedRunIds: matched.map(run => run.id),
        matchedStatuses: matched.map(run => run.status),
        queuedCount: report.queuedCount || 0,
        remainingAutonomousQuota: report.remainingAutonomousQuota ?? null,
      });
      saveRecord();
      console.log(`[${spec.logTag}] observed ${designated.benchmarkOpportunityId} ${outcome} run=${matched[matched.length - 1].id}`);
    }
    const statesNow = record.designatedOpportunities.map(item => rowState(item.benchmarkOpportunityId));
    if (isScopeTerminallyAccounted(statesNow)) {
      record.status = 'COMPLETE';
      record.stopReason = 'SCOPE_COVERED';
      saveRecord();
      console.log(`[${spec.logTag}] COMPLETE: all ${spec.scopeSize} designated opportunities terminally accounted`);
      await db.end().catch(() => undefined);
      process.exit(0);
    }
    if ((report.remainingAutonomousQuota ?? 1) <= 0) {
      await abortIncomplete('QUOTA_CEILING');
    }
  }

  const finalStates = record.designatedOpportunities.map(item => rowState(item.benchmarkOpportunityId));
  if (isScopeTerminallyAccounted(finalStates)) {
    record.status = 'COMPLETE';
    record.stopReason = 'SCOPE_COVERED';
    saveRecord();
    console.log(`[${spec.logTag}] COMPLETE: all ${spec.scopeSize} designated opportunities terminally accounted`);
    await db.end().catch(() => undefined);
    process.exit(0);
  }
  await abortIncomplete('DESIGNATED_ROWS_UNACCOUNTED');
}

main().catch(error => {
  console.error(`[benchmark-prereg] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
