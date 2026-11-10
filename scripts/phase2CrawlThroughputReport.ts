/**
 * Phase 2 Option C crawl-throughput report (read-only).
 *
 * Reads the append-only `acquisition_lane_events` baseline and reports the
 * capacity-lane crawls/hour against the 40/h nominal target, the 48/h
 * emergency ceiling, and the 35% DISCOVERY floor.
 *
 * The script never inserts, updates, or deletes a row. It uses the dedicated
 * read-only pool and one REPEATABLE READ transaction.
 *
 * Usage:
 *   npx tsx scripts/phase2CrawlThroughputReport.ts
 *   npx tsx scripts/phase2CrawlThroughputReport.ts --window-hours=6 --check
 */

import { writeFileSync } from 'node:fs';
import { createReadOnlyDbPool } from '../server/db';
import {
  buildCrawlThroughputReport,
  crawlThroughputWindowStart,
  parsePhase2CrawlThroughputReportArgs,
  PHASE2_CRAWL_THROUGHPUT_USAGE,
  type CrawlThroughputEventRow,
} from '../server/crawlThroughputReport';

async function writeStdout(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(text, error => error ? reject(error) : resolve());
  });
}

async function main(): Promise<void> {
  const args = parsePhase2CrawlThroughputReportArgs(process.argv.slice(2));
  if (args.help) {
    await writeStdout(`${PHASE2_CRAWL_THROUGHPUT_USAGE}\n`);
    return;
  }

  const now = new Date();
  const querySince = crawlThroughputWindowStart(now, args.windowHours).toISOString();
  const pool = createReadOnlyDbPool('phase2-crawl-throughput-report');
  let client: Awaited<ReturnType<typeof pool.connect>> | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    let rows: CrawlThroughputEventRow[];
    try {
      const result = await client.query(
        `SELECT observed_at, lane, outcome, gate_wait_ms,
                pages_inspected, requests_started, capacity_event
           FROM acquisition_lane_events
          WHERE observed_at >= $1
          ORDER BY observed_at`,
        [querySince],
      );
      rows = result.rows as CrawlThroughputEventRow[];
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }

    const report = buildCrawlThroughputReport(rows, {
      windowHours: args.windowHours,
      now,
    });
    const json = JSON.stringify(report, null, 2);
    if (args.out) writeFileSync(args.out, `${json}\n`, 'utf8');
    await writeStdout(`${json}\n`);

    if (args.check && report.failures.length > 0) {
      process.exitCode = 1;
      console.error(JSON.stringify({
        event: 'phase2_crawl_throughput_check_failed',
        failures: report.failures,
        generatedAt: report.generatedAt,
      }));
    }
  } finally {
    client?.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(JSON.stringify({
    event: 'phase2_crawl_throughput_report_failed',
    error: error instanceof Error ? error.message : String(error),
    timestamp: new Date().toISOString(),
  }));
  process.exitCode = 1;
});
