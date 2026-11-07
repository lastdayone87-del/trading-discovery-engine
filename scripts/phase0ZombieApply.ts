/**
 * Phase 0 zombie retry reconciliation — operator-gated bounded apply CLI.
 *
 * Runs the same evidence classification as the read-only dry-run. Without
 * `--apply` it only prints the bounded plan. With `--apply` and an explicit
 * `--actor` it closes at most `--max-closures` evidence-backed PENDING jobs and
 * records append-only closure evidence.
 *
 * The whole run is one transaction. Candidate jobs are locked with
 * `FOR UPDATE SKIP LOCKED`, so workers skip them while the batch is audited.
 * The apply path never deletes rows and never scans beyond `--max-scan`.
 *
 * Usage:
 *   npx tsx scripts/phase0ZombieApply.ts --max-closures=100
 *   npx tsx scripts/phase0ZombieApply.ts --apply --actor=operator@example \
 *     --max-scan=500 --max-closures=100 --out=/tmp/zombie-apply.json
 */

import { writeFileSync } from 'node:fs';
import { createOperatorWriteDbPool } from '../server/db';
import {
  parsePhase0ZombieApplyArgs,
  phase0ZombieApplyCheckFailures,
  PHASE0_ZOMBIE_APPLY_USAGE,
  runPhase0ZombieApply,
} from '../server/phase0ZombieApply';

async function writeStdout(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(text, error => error ? reject(error) : resolve());
  });
}

async function main(): Promise<void> {
  const args = parsePhase0ZombieApplyArgs(process.argv.slice(2));
  if (args.help) {
    await writeStdout(`${PHASE0_ZOMBIE_APPLY_USAGE}\n`);
    return;
  }

  const pool = createOperatorWriteDbPool('phase0-zombie-apply');
  let client: Awaited<ReturnType<typeof pool.connect>> | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    let report;
    try {
      report = await runPhase0ZombieApply(client, {
        apply: args.apply,
        actor: args.actor,
        maxScan: args.maxScan,
        maxClosures: args.maxClosures,
        includeRows: args.includeRows,
      });
      // A preview acquired row locks only to prove the same bounded candidate
      // set; roll back so a report-only run cannot leave locks behind.
      if (args.apply) await client.query('COMMIT');
      else await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }

    const json = JSON.stringify(report, null, 2);
    if (args.out) writeFileSync(args.out, `${json}\n`, 'utf8');
    await writeStdout(`${json}\n`);

    if (args.check) {
      const failures = phase0ZombieApplyCheckFailures(report);
      if (failures.length > 0) {
        process.exitCode = 1;
        console.error(JSON.stringify({
          event: 'phase0_zombie_apply_check_failed',
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
    event: 'phase0_zombie_apply_failed',
    error: error instanceof Error ? error.message : String(error),
    timestamp: new Date().toISOString(),
  }));
  process.exitCode = 1;
});
