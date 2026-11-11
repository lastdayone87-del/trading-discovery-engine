/**
 * Phase 2 Unit 4 retry-backlog triage — read-only CLI.
 *
 * Usage:
 *   npx tsx scripts/phase2RetryBacklogTriage.ts
 *   npx tsx scripts/phase2RetryBacklogTriage.ts --include-rows --check
 */

import { writeFileSync } from 'node:fs';
import { createReadOnlyDbPool } from '../server/db';
import {
  buildRetryBacklogTriageReport,
  parseRetryBacklogTriageArgs,
  retryBacklogTriageCheckFailures,
  RETRY_BACKLOG_TRIAGE_USAGE,
} from '../server/retryBacklogTriage';

async function writeStdout(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(text, error => error ? reject(error) : resolve());
  });
}

async function main(): Promise<void> {
  const args = parseRetryBacklogTriageArgs(process.argv.slice(2));
  if (args.help) {
    await writeStdout(`${RETRY_BACKLOG_TRIAGE_USAGE}\n`);
    return;
  }

  const pool = createReadOnlyDbPool('phase2-retry-backlog-triage');
  let client: Awaited<ReturnType<typeof pool.connect>> | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    let report;
    try {
      report = await buildRetryBacklogTriageReport(client, {
        maxJobs: args.maxJobs,
        includeRows: args.includeRows,
        cursor: args.cursor,
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }

    const json = JSON.stringify(report, null, 2);
    await writeStdout(`${json}\n`);
    if (args.out) writeFileSync(args.out, `${json}\n`, 'utf8');

    if (args.check) {
      const failures = retryBacklogTriageCheckFailures(report);
      if (failures.length > 0) {
        process.exitCode = 1;
        console.error(JSON.stringify({
          event: 'phase2_retry_backlog_triage_check_failed',
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
    event: 'phase2_retry_backlog_triage_failed',
    error: error instanceof Error ? error.message : String(error),
    timestamp: new Date().toISOString(),
  }));
  process.exitCode = 1;
});
