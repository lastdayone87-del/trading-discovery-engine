/**
 * Minimal execution runner for benchmark-preregistration-v1.
 *
 * Sole authority: docs/BENCHMARK_PREREGISTRATION.md. This script is NOT a
 * new benchmark and shares nothing with fastBenchmark, evaluateBenchmark,
 * semantic benchmarks, or any other script: those are different benchmarks
 * and must never be substituted here.
 *
 * Modes (no benchmark observations are created unless --execute is passed):
 * - plan (default): read-only against the database. Verifies frozen
 *   versions and gates, exports the deterministic 300-row pool snapshot +
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
 *   npx tsx scripts/runBenchmarkPreregV1.ts --plan --out ./benchmark-prereg-v1
 *   npx tsx scripts/runBenchmarkPreregV1.ts --execute --out ./benchmark-prereg-v1
 */
import dotenv from 'dotenv';
dotenv.config();
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../server/db';
import { rowToQuery } from '../server/dbCore';
import {
  BENCHMARK_PREREG_SPEC_VERSION,
  BENCHMARK_PREREG_FROZEN_BASE_COMMIT,
  BENCHMARK_PREREG_SCOPE_SIZE,
  BENCHMARK_PREREG_WALL_CLOCK_DAYS,
  BENCHMARK_PREREG_FROZEN_MIGRATION_COUNT,
  verifyFrozenBenchmarkVersions,
  verifyBenchmarkGatesOff,
  buildFrozenBenchmarkRequest,
  buildPoolSnapshot,
  verifyPoolSnapshotHash,
  computeConfigurationHash,
  buildExecutionRecord,
  type BenchmarkExecutionRecord,
  type PoolSnapshot,
} from '../server/benchmarkPreregV1';

const DAY_MS = 24 * 60 * 60 * 1000;

function usageError(message: string): never {
  console.error(`[benchmark-prereg-v1] ${message}`);
  console.error('Usage: npx tsx scripts/runBenchmarkPreregV1.ts [--plan|--execute] --out <dir> [--force]');
  process.exit(1);
}

function parseArgs(argv: string[]): { mode: 'plan' | 'execute'; outDir: string; force: boolean } {
  let mode: 'plan' | 'execute' = 'plan';
  let outDir = '';
  let force = false;
  for (const arg of argv) {
    if (arg === '--execute') mode = 'execute';
    else if (arg === '--plan') mode = 'plan';
    else if (arg === '--force') force = true;
    else if (arg.startsWith('--out=')) outDir = arg.slice('--out='.length);
    else if (arg === '--out') outDir = argv[argv.indexOf(arg) + 1] || '';
    else if (arg.startsWith('--')) usageError(`Unknown flag ${arg}`);
  }
  if (!outDir) usageError('Missing required --out <dir>');
  return { mode, outDir: resolve(outDir), force };
}

function runningCommit(repoRoot: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    throw new Error('BENCHMARK_PREREG_PROVENANCE_UNAVAILABLE: git rev-parse HEAD failed');
  }
}

function effectiveNumberedSetting(settings: Record<string, string>, key: string, envKey: string, fallback: string, min: number): number {
  const raw = settings[key] ?? process.env[envKey] ?? fallback;
  return Math.max(min, Number(raw) || Number(fallback));
}

async function main(): Promise<void> {
  const { mode, outDir, force } = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const commit = runningCommit(repoRoot);
  console.log(`[benchmark-prereg-v1] mode=${mode} spec=${BENCHMARK_PREREG_SPEC_VERSION} frozenBase=${BENCHMARK_PREREG_FROZEN_BASE_COMMIT} running=${commit}`);

  // Fail closed on any frozen drift before touching anything else.
  verifyFrozenBenchmarkVersions();

  const db = await getDb();
  const settingsRows = (await db.query('SELECT setting_key, setting_value FROM app_settings ORDER BY setting_key')).rows as Array<{ setting_key: string; setting_value: string }>;
  const settings: Record<string, string> = Object.fromEntries(settingsRows.map(row => [row.setting_key, row.setting_value]));
  verifyBenchmarkGatesOff(settings);

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
    const cooldownMinutes = effectiveNumberedSetting(settings, 'query_intelligence_query_cooldown_minutes', 'QUERY_INTELLIGENCE_COOLDOWN_MINUTES', '360', 1);
    const maxPrimaryUses = effectiveNumberedSetting(settings, 'query_intelligence_primary_term_max_uses', 'QUERY_INTELLIGENCE_PRIMARY_TERM_MAX_USES', '2', 1);
    const snapshot = buildPoolSnapshot({
      rows: libraryRows.map(row => rowToQuery(row)),
      collectedAt: now,
      cooldownMinutes,
      maxPrimaryUses,
    });
    if (snapshot.rows.length === 0) {
      throw new Error('BENCHMARK_PREREG_EMPTY_POOL: no eligible opportunities; refusing to freeze an empty scope');
    }
    const providerRegistry = (await db.query(
      'SELECT provider_key, provider_family, provider_kind, capabilities, quota_domain, mode, daily_cost_cap, configuration_version FROM discovery_provider_registry ORDER BY provider_key'
    )).rows as Array<Record<string, unknown>>;
    const configurationHash = computeConfigurationHash({ appSettings: settingsRows, maxMigrationVersion, providerRegistry });
    const record = buildExecutionRecord({ runningCommit: commit, poolSnapshot: snapshot, configurationHash, maxMigrationVersion, providerRegistry });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`[benchmark-prereg-v1] PLANNED rows=${snapshot.rows.length}/${snapshot.candidateRows} hash=${snapshot.snapshotHash}`);
    console.log(`[benchmark-prereg-v1] configHash=${configurationHash} out=${outDir}`);
    console.log(`[benchmark-prereg-v1] Execute ONLY with explicit approval: npx tsx scripts/runBenchmarkPreregV1.ts --execute --out ${outDir}`);
    await db.end().catch(() => undefined);
    return;
  }

  // --execute: frozen execution through the untouched engine path.
  if (!existsSync(recordPath) || !existsSync(snapshotPath)) {
    throw new Error('BENCHMARK_PREREG_NO_PLAN: run --plan first; refusing to execute without a frozen snapshot + record');
  }
  const record = JSON.parse(readFileSync(recordPath, 'utf8')) as BenchmarkExecutionRecord;
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as PoolSnapshot;
  if (
    record.specVersion !== BENCHMARK_PREREG_SPEC_VERSION ||
    record.frozenBaseCommit !== BENCHMARK_PREREG_FROZEN_BASE_COMMIT ||
    record.poolSnapshot.snapshotHash !== snapshot.snapshotHash ||
    (record.status !== 'PLANNED' && record.status !== 'IN_PROGRESS')
  ) {
    throw new Error('BENCHMARK_PREREG_RECORD_MISMATCH: execution record does not match the frozen plan; refusing to execute');
  }
  verifyPoolSnapshotHash(snapshot);
  record.status = 'IN_PROGRESS';
  record.runningCommit = commit;

  const { runAutonomousDiscoveryCycle, getAutonomousDiscoveryStatus } = await import('../server/autonomousDiscovery');
  const { getAppSetting } = await import('../server/dbCore');
  const status = await getAutonomousDiscoveryStatus().catch(() => null);
  if (status?.isRunning) {
    throw new Error('BENCHMARK_PREREG_SCHEDULER_BUSY: autonomous scheduler already running; stop it before executing');
  }

  const deadlineOf = (firstObservedAt: string | null): number =>
    new Date(firstObservedAt || record.createdAt).getTime() + BENCHMARK_PREREG_WALL_CLOCK_DAYS * DAY_MS;
  let firstObservedAt: string | null = null;
  const covered = new Set<string>(
    (record.attempts as Array<{ benchmarkOpportunityId?: string; matchedRunIds?: string[] }>)
      .filter(attempt => (attempt.matchedRunIds || []).length > 0)
      .map(attempt => String(attempt.benchmarkOpportunityId))
  );
  const saveRecord = () => {
    record.updatedAt = new Date().toISOString();
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  };

  for (const designated of record.designatedOpportunities) {
    if (covered.has(designated.benchmarkOpportunityId)) continue;
    if (Date.now() > deadlineOf(firstObservedAt)) {
      record.status = 'INCOMPLETE';
      record.stopReason = 'WALL_CLOCK_CEILING';
      saveRecord();
      console.log('[benchmark-prereg-v1] INCOMPLETE: 14-day ceiling reached');
      await db.end().catch(() => undefined);
      process.exit(1);
    }
    if ((await getAppSetting('query_intelligence_paused', 'false')) === 'true') {
      record.status = 'INCOMPLETE';
      record.stopReason = 'KILL_SWITCH_PAUSED';
      saveRecord();
      throw new Error('BENCHMARK_PREREG_KILL_SWITCH: query intelligence paused mid-run; intake stopped');
    }
    const attemptStart = new Date();
    const requestId = `benchmark-prereg-v1:${snapshot.snapshotHash.slice(0, 12)}:${designated.poolRowId}`;
    let report: {
      queuedCount?: number; remainingAutonomousQuota?: number; summary?: string;
      diagnostics?: { candidates?: Array<{ disposition?: string; reasonCode?: string }> };
    };
    try {
      const row = snapshot.rows.find(candidate => candidate.queryId === designated.poolRowId);
      if (!row) throw new Error(`BENCHMARK_PREREG_DESIGNATED_ROW_MISSING: poolRowId=${designated.poolRowId}`);
      const frozenRequest = buildFrozenBenchmarkRequest(snapshot.snapshotHash, row.queryId);
      report = await runAutonomousDiscoveryCycle(row.country, undefined, requestId, frozenRequest);
    } catch (error) {
      record.status = 'INCOMPLETE';
      record.stopReason = `INFRA_INCIDENT:${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
      record.attempts.push({ benchmarkOpportunityId: designated.benchmarkOpportunityId, poolRowId: designated.poolRowId, error: record.stopReason });
      saveRecord();
      throw error;
    }
    const attemptEnd = new Date();
    const matched = (await db.query(
      `SELECT id, query_id, status, scheduled_at FROM query_runs
       WHERE metadata->'selectionExperiment'->>'benchmarkOpportunityId' = $1 AND scheduled_at >= $2
       ORDER BY scheduled_at`,
      [designated.benchmarkOpportunityId, attemptStart.toISOString()]
    )).rows as Array<{ id: string; query_id: number; status: string; scheduled_at: string }>;
    const windowRuns = (await db.query(
      `SELECT id, metadata->'selectionExperiment'->>'benchmarkOpportunityId' AS boid FROM query_runs
       WHERE scheduled_at >= $1 AND scheduled_at < $2`,
      [attemptStart.toISOString(), attemptEnd.toISOString()]
    )).rows as Array<{ id: string; boid: string | null }>;
    const extras = windowRuns.filter(run => run.boid !== designated.benchmarkOpportunityId);
    if (matched.length > 0 && !firstObservedAt) {
      firstObservedAt = matched.map(run => run.scheduled_at).sort()[0];
    }
    if (matched.length > 0) covered.add(designated.benchmarkOpportunityId);
    let exclusionReason: string | null = null;
    if (matched.length === 0) {
      const candidates = report.diagnostics?.candidates || [];
      const skipped = candidates.find(candidate => candidate.disposition && candidate.disposition !== 'SCHEDULED');
      exclusionReason = skipped ? `${skipped.disposition}:${skipped.reasonCode || 'UNKNOWN'}` : `CYCLE_SCHEDULED_NOTHING:${(report.summary || '').slice(0, 200)}`;
    }
    record.attempts.push({
      benchmarkOpportunityId: designated.benchmarkOpportunityId,
      poolRowId: designated.poolRowId,
      country: designated.country,
      cycleRequestId: requestId,
      matchedRunIds: matched.map(run => run.id),
      matchedStatuses: matched.map(run => run.status),
      exclusionReason,
      queuedCount: report.queuedCount || 0,
      remainingAutonomousQuota: report.remainingAutonomousQuota ?? null,
    });
    if (extras.length > 0) {
      record.extras.push({ afterOpportunity: designated.benchmarkOpportunityId, count: extras.length, runIds: extras.slice(0, 50).map(run => run.id) });
    }
    saveRecord();
    console.log(`[benchmark-prereg-v1] ${covered.size}/${BENCHMARK_PREREG_SCOPE_SIZE} opportunity=${designated.benchmarkOpportunityId} matched=${matched.length} extras=${extras.length}${exclusionReason ? ` excluded=${exclusionReason}` : ''}`);
    if ((report.remainingAutonomousQuota ?? 1) <= 0) {
      record.status = covered.size >= BENCHMARK_PREREG_SCOPE_SIZE ? 'COMPLETE' : 'INCOMPLETE';
      record.stopReason = 'QUOTA_CEILING';
      saveRecord();
      console.log(`[benchmark-prereg-v1] ${record.status}: quota ceiling reached`);
      await db.end().catch(() => undefined);
      process.exit(record.status === 'COMPLETE' ? 0 : 1);
    }
    if (covered.size >= BENCHMARK_PREREG_SCOPE_SIZE) {
      record.status = 'COMPLETE';
      record.stopReason = 'SCOPE_COVERED';
      saveRecord();
      console.log('[benchmark-prereg-v1] COMPLETE: all 300 designated opportunities observed or excluded');
      await db.end().catch(() => undefined);
      process.exit(0);
    }
  }

  record.status = covered.size >= BENCHMARK_PREREG_SCOPE_SIZE ? 'COMPLETE' : 'INCOMPLETE';
  record.stopReason = covered.size >= BENCHMARK_PREREG_SCOPE_SIZE ? 'SCOPE_COVERED' : 'DESIGNATED_ROWS_UNCOVERED';
  saveRecord();
  console.log(`[benchmark-prereg-v1] ${record.status}: covered=${covered.size}/${BENCHMARK_PREREG_SCOPE_SIZE}`);
  await db.end().catch(() => undefined);
  process.exit(record.status === 'COMPLETE' ? 0 : 1);
}

main().catch(error => {
  console.error(`[benchmark-prereg-v1] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
