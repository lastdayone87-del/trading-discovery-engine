/**
 * Phase 0 zombie retry reconciliation — dry-run CLI (read-only).
 *
 * Prints the evidence-backed closure proposals for pending
 * `RETRY_COMMUNITY_ACQUISITION` jobs. It never updates the jobs table and is
 * intentionally separate from the bounded apply path: an operator reviews this
 * output, audits the proposals, and only then runs the gated apply.
 *
 * The whole report runs in one REPEATABLE READ, READ ONLY snapshot on a pool
 * that skips migrations and seeding.
 *
 * Usage:
 *   npx tsx scripts/phase0ZombieReconciliationDryRun.ts
 *   npx tsx scripts/phase0ZombieReconciliationDryRun.ts --check --out=/tmp/zombies.json
 */

import { writeFileSync } from 'node:fs';
import { createReadOnlyDbPool } from '../server/db';
import {
  buildPhase0ZombieReconciliationReport,
  parsePhase0ZombieReconciliationArgs,
  phase0ZombieReconciliationCheckFailures,
  PHASE0_ZOMBIE_RECONCILIATION_USAGE,
} from '../server/phase0ZombieReconciliation';

async function writeStdout(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(text, error => error ? reject(error) : resolve());
  });
}

async function main(): Promise<void> {
  const args = parsePhase0ZombieReconciliationArgs(process.argv.slice(2));
  if (args.help) {
    await writeStdout(`${PHASE0_ZOMBIE_RECONCILIATION_USAGE}\n`);
    return;
  }

  const pool = createReadOnlyDbPool();
  let client: Awaited<ReturnType<typeof pool.connect>> | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    let report;
    try {
      report = await buildPhase0ZombieReconciliationReport(client, {
        maxJobs: args.maxJobs,
        includeRows: args.includeRows,
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }

    const json = JSON.stringify(report, null, 2);
    if (args.out) writeFileSync(args.out, `${json}\n`, 'utf8');
    await writeStdout(`${json}\n`);

    if (args.check) {
      const failures = phase0ZombieReconciliationCheckFailures(report);
      if (failures.length > 0) {
        process.exitCode = 1;
        console.error(JSON.stringify({
          event: 'phase0_zombie_reconciliation_dry_run_check_failed',
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
    event: 'phase0_zombie_reconciliation_dry_run_failed',
    error: error instanceof Error ? error.message : String(error),
    timestamp: new Date().toISOString(),
  }));
  process.exitCode = 1;
});
