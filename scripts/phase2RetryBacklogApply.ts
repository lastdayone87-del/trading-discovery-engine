/**
 * Phase 2 Unit 4 retry-backlog triage — operator-gated bounded apply.
 *
 * Without `--apply` it only prints the plan. With `--apply` and `--actor` it
 * performs at most `--max-actions` terminal closures / reversible quarantines
 * in one transaction. Original priority/run_after are preserved in
 * `retry_backlog_triage`; no job payload, attempt, channel, or observation is
 * rewritten or deleted.
 *
 * Usage:
 *   npx tsx scripts/phase2RetryBacklogApply.ts --include-rows
 *   npx tsx scripts/phase2RetryBacklogApply.ts --apply --actor=operator@example \
 *     --max-actions=100 --out=/tmp/retry-triage-apply.json
 */

import { writeFileSync } from 'node:fs';
import { createOperatorWriteDbPool } from '../server/db';
import {
  parseRetryBacklogApplyArgs,
  RETRY_BACKLOG_APPLY_USAGE,
  runRetryBacklogTriageApply,
} from '../server/retryBacklogTriageApply';

async function writeStdout(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(text, error => error ? reject(error) : resolve());
  });
}

async function main(): Promise<void> {
  const args = parseRetryBacklogApplyArgs(process.argv.slice(2));
  if (args.help) {
    await writeStdout(`${RETRY_BACKLOG_APPLY_USAGE}\n`);
    return;
  }

  const pool = createOperatorWriteDbPool('phase2-retry-backlog-apply');
  let client: Awaited<ReturnType<typeof pool.connect>> | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    let report;
    let committed = false;
    try {
      report = await runRetryBacklogTriageApply(client, {
        apply: args.apply,
        actor: args.actor,
        maxScan: args.maxScan,
        maxActions: args.maxActions,
        buckets: args.buckets,
        ...(args.jobIds ? { jobIds: args.jobIds } : {}),
        includeRows: args.includeRows,
      });
      if (args.apply && report.summary.applied > 0) {
        await client.query('COMMIT');
        committed = true;
      } else {
        await client.query('ROLLBACK');
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }

    const output = {
      ...report,
      transaction: committed ? 'COMMITTED' : 'ROLLED_BACK',
    };
    const json = JSON.stringify(output, null, 2);
    if (args.out) writeFileSync(args.out, `${json}\n`, 'utf8');
    await writeStdout(`${json}\n`);
  } finally {
    client?.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(JSON.stringify({
    event: 'phase2_retry_backlog_apply_failed',
    error: error instanceof Error ? error.message : String(error),
    timestamp: new Date().toISOString(),
  }));
  process.exitCode = 1;
});
