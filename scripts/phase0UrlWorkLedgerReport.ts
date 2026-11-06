/**
 * Phase 0 URL work ledger report (read-only).
 *
 * Derives the work rows Phase 1 would materialize for the current retry
 * backlog and reconciles the projection against the independent telemetry
 * bound: unique retry-owning URL/surface work observed in the window.
 *
 * The script never inserts, updates, or deletes a row. It opens a dedicated
 * pool that skips migrations/seeding and defaults to read-only transactions,
 * then runs the whole report in one REPEATABLE READ snapshot. In Phase 0 the
 * ledger table is intentionally empty; the report proves the derivation and
 * gives the bounds the Phase 1 backfill must match.
 *
 * Usage:
 *   npx tsx scripts/phase0UrlWorkLedgerReport.ts
 *   npx tsx scripts/phase0UrlWorkLedgerReport.ts --window-days=14 --check
 */

import { writeFileSync } from 'node:fs';
import { createReadOnlyDbPool } from '../server/db';
import {
  buildPhase0UrlWorkLedgerReport,
  parsePhase0UrlWorkLedgerReportArgs,
  PHASE0_URL_WORK_LEDGER_USAGE,
} from '../server/phase0UrlWorkLedgerReport';

async function writeStdout(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(text, error => error ? reject(error) : resolve());
  });
}

async function main(): Promise<void> {
  const args = parsePhase0UrlWorkLedgerReportArgs(process.argv.slice(2));
  if (args.help) {
    await writeStdout(`${PHASE0_URL_WORK_LEDGER_USAGE}\n`);
    return;
  }

  const pool = createReadOnlyDbPool();
  let client: Awaited<ReturnType<typeof pool.connect>> | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    let report;
    try {
      report = await buildPhase0UrlWorkLedgerReport(client, {
        windowDays: args.windowDays,
        maxDeltaPct: args.maxDeltaPct,
        includeRows: args.includeRows,
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }

    const json = JSON.stringify(report, null, 2);
    if (args.out) writeFileSync(args.out, `${json}\n`, 'utf8');
    // Never force an immediate process exit: stdout must drain first.
    await writeStdout(`${json}\n`);

    if (args.check) {
      const failures: string[] = [];
      if (!report.schema.ledgerTablePresent) failures.push('ledger_table_missing');
      if (report.telemetry.retryableRows <= 0) failures.push('no_retryable_work_measured');
      if (!report.reconciliation.retryableWithinFivePercent) {
        failures.push('retryable_projection_delta_exceeds_tolerance');
      }
      if (!report.reconciliation.neverExecutedWithinFivePercent) {
        failures.push('retryable_never_browser_executed_delta_exceeds_tolerance');
      }
      if (failures.length > 0) {
        process.exitCode = 1;
        console.error(JSON.stringify({
          event: 'phase0_url_work_ledger_check_failed',
          failures,
          generatedAt: report.generatedAt,
        }));
      }
    }
  } finally {
    client?.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(JSON.stringify({
    event: 'phase0_url_work_ledger_report_failed',
    error: error instanceof Error ? error.message : String(error),
    timestamp: new Date().toISOString(),
  }));
  process.exitCode = 1;
});
