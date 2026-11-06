/**
 * Phase 0 URL work ledger report (read-only).
 *
 * Derives the work rows Phase 1 would materialize for the current retry
 * backlog and reconciles the projection against the independent telemetry
 * bound: unique retryable URL/surface work observed in the window.
 *
 * The script never inserts, updates, or deletes a row. In Phase 0 the ledger
 * table is intentionally empty; the report proves the derivation and gives the
 * bounds the Phase 1 backfill must match.
 *
 * Usage:
 *   npx tsx scripts/phase0UrlWorkLedgerReport.ts
 *   npx tsx scripts/phase0UrlWorkLedgerReport.ts --window-days=14 --check
 */

import { writeFileSync } from 'node:fs';
import { getDb } from '../server/db';
import { buildPhase0UrlWorkLedgerReport } from '../server/phase0UrlWorkLedgerReport';

interface ReportArgs {
  windowDays: number;
  maxDeltaPct: number;
  check: boolean;
  includeRows: boolean;
  out: string | null;
}

function parseArgs(argv: string[]): ReportArgs {
  const args: ReportArgs = {
    windowDays: 14,
    maxDeltaPct: 5,
    check: false,
    includeRows: false,
    out: null,
  };
  for (const raw of argv) {
    if (raw === '--check') args.check = true;
    else if (raw === '--include-rows') args.includeRows = true;
    else if (raw.startsWith('--window-days=')) {
      args.windowDays = Math.max(1, Math.min(90, Number(raw.split('=')[1]) || 14));
    } else if (raw.startsWith('--max-delta-pct=')) {
      args.maxDeltaPct = Math.max(0, Math.min(100, Number(raw.split('=')[1]) || 5));
    } else if (raw.startsWith('--out=')) {
      args.out = raw.slice('--out='.length) || null;
    } else if (raw === '--help' || raw === '-h') {
      console.log('Usage: npx tsx scripts/phase0UrlWorkLedgerReport.ts [--window-days=14] [--max-delta-pct=5] [--check] [--include-rows] [--out=path]');
      process.exit(0);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = await getDb();
  const report = await buildPhase0UrlWorkLedgerReport(db, {
    windowDays: args.windowDays,
    maxDeltaPct: args.maxDeltaPct,
    includeRows: args.includeRows,
  });

  const json = JSON.stringify(report, null, 2);
  if (args.out) writeFileSync(args.out, `${json}\n`, 'utf8');
  console.log(json);

  if (args.check && (!report.schema.ledgerTablePresent
    || !report.reconciliation.retryableWithinFivePercent
    || !report.reconciliation.neverExecutedWithinFivePercent)) {
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0))
  .catch(error => {
    console.error(JSON.stringify({
      event: 'phase0_url_work_ledger_report_failed',
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }));
    process.exit(1);
  });
