/**
 * Phase 0 zombie retry reconciliation — operator-gated bounded apply CLI.
 *
 * Runs the same evidence classification as the read-only dry-run. Without
 * `--apply` it only prints the bounded plan. With `--apply` and an explicit
 * `--actor` it closes at most `--max-closures` evidence-backed PENDING jobs and
 * records append-only closure evidence.
 *
 * The whole run is one READ COMMITTED transaction. Candidate jobs are locked
 * with `FOR UPDATE SKIP LOCKED`, so workers skip them while the batch is
 * audited, and the closure UPDATE re-checks ownership evidence at statement
 * time. `--check` failures roll the batch back before commit.
 *
 * The operator must review a fresh dry-run first. The CLI cannot prove that
 * review happened; it can only require the explicit `--apply` + `--actor`
 * gate and keep the batch small enough for a full audit.
 *
 * Usage:
 *   npx tsx scripts/phase0ZombieApply.ts --max-closures=100
 *   npx tsx scripts/phase0ZombieApply.ts --apply --actor=operator@example \
 *     --max-scan=500 --max-closures=100 --out=/tmp/zombie-apply.json
 */

import { writeFileSync } from 'node:fs';
import { createOperatorWriteDbPool } from '../server/db';
import {
  finalizePhase0ZombieApplyReport,
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
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    let report;
    try {
      report = await runPhase0ZombieApply(client, {
        apply: args.apply,
        actor: args.actor,
        maxScan: args.maxScan,
        maxClosures: args.maxClosures,
        cursor: args.cursor,
        includeRows: args.includeRows,
      });

      // Evaluate the gate before committing: a failed check must not leave a
      // partial batch persisted while the process exits non-zero.
      const failures = args.check ? phase0ZombieApplyCheckFailures(report) : [];
      const committed = args.apply && failures.length === 0;
      if (committed) {
        await client.query('COMMIT');
      } else {
        await client.query('ROLLBACK');
      }

      // A rolled-back batch wrote nothing: do not let the audit artifact claim
      // persisted closures, actors, or closure timestamps.
      const output = finalizePhase0ZombieApplyReport(
        report,
        committed ? 'COMMITTED' : 'ROLLED_BACK',
      );
      const json = JSON.stringify(output, null, 2);
      // Print the committed closure list before touching the optional output
      // file: a disk error must not hide what the database already accepted.
      await writeStdout(`${json}\n`);
      if (args.out) writeFileSync(args.out, `${json}\n`, 'utf8');

      if (failures.length > 0) {
        process.exitCode = 1;
        console.error(JSON.stringify({
          event: 'phase0_zombie_apply_check_failed',
          failures,
          generatedAt: report.generatedAt,
          transaction: 'ROLLED_BACK',
        }));
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
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
