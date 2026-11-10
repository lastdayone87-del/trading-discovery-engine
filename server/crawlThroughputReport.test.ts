import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildCrawlThroughputReport,
  crawlThroughputWindowStart,
  parsePhase2CrawlThroughputReportArgs,
  PHASE2_DISCOVERY_FLOOR_PERCENT,
  PHASE2_EMERGENCY_CRAWLS_PER_HOUR,
  PHASE2_NOMINAL_CRAWLS_PER_HOUR,
  PHASE2_REPORT_MAX_WINDOW_HOURS,
  type CrawlThroughputEventRow,
} from './crawlThroughputReport';

interface RowOptions {
  renderedCrawls?: number;
  gateWaitMs?: number;
  omitDetail?: boolean;
}

function row(
  observedAt: string,
  lane: string,
  outcome: string,
  options: RowOptions = {},
): CrawlThroughputEventRow {
  return {
    observed_at: observedAt,
    lane,
    outcome,
    gate_wait_ms: options.gateWaitMs ?? null,
    pages_inspected: 0,
    requests_started: 0,
    capacity_event: null,
    ...(options.omitDetail
      ? {}
      : { detail: { renderedCrawls: options.renderedCrawls ?? 0 } }),
  };
}

test('report counts rendered seed crawls, not inspection passes, and includes maintenance', () => {
  const report = buildCrawlThroughputReport([
    row('2026-11-10T11:10:00.000Z', 'DISCOVERY', 'ACQUIRED', { renderedCrawls: 1, gateWaitMs: 1200 }),
    row('2026-11-10T11:40:00.000Z', 'RETRY', 'PARTIALLY_INSPECTED', { renderedCrawls: 2 }),
    row('2026-11-10T12:10:00.000Z', 'ENRICHMENT', 'CAPACITY_DEFERRED', { renderedCrawls: 0 }),
    row('2026-11-10T12:20:00.000Z', 'MAINTENANCE', 'ACQUIRED', { renderedCrawls: 1 }),
  ], {
    windowHours: 2,
    now: new Date('2026-11-10T12:30:00.000Z'),
  });

  assert.equal(report.windowStart, '2026-11-10T11:00:00.000Z');
  assert.deepEqual(report.buckets.map(bucket => bucket.hour), [
    '2026-11-10T11:00:00.000Z',
    '2026-11-10T12:00:00.000Z',
  ]);

  const first = report.buckets[0];
  assert.equal(first.inspectionPasses, 2);
  assert.equal(first.browserCrawls, 3, 'two seeds in one RETRY pass are two crawls');
  assert.equal(first.discoveryBrowserCrawls, 1);
  assert.equal(first.completedPasses, 2);
  assert.equal(first.discoverySharePct, 33.33);
  assert.deepEqual(first.gateWait, { samples: 1, averageMs: 1200, maxMs: 1200 });

  const second = report.buckets[1];
  assert.equal(second.inspectionPasses, 2);
  assert.equal(second.browserCrawls, 1, 'recovery maintenance can use the browser slot');
  assert.equal(second.discoveryBrowserCrawls, 0);
  assert.equal(second.deferredPasses, 1);
  assert.equal(second.completedPasses, 1);
  assert.equal(second.discoverySharePct, 0);

  assert.equal(report.totals.inspectionPasses, 4);
  assert.equal(report.totals.browserCrawls, 4);
  assert.equal(report.totals.discoveryBrowserCrawls, 1);
  assert.equal(report.totals.maintenanceBrowserCrawls, 1);
  assert.equal(report.totals.unknownBrowserCrawls, 0);
  assert.equal(report.totals.completedPasses, 3);
  assert.equal(report.totals.deferredPasses, 1);
  assert.equal(report.totals.discoverySharePct, 25);
  assert.deepEqual(report.totals.gateWait, { samples: 1, averageMs: 1200, maxMs: 1200 });
  assert.deepEqual(report.lanes.DISCOVERY, { inspectionPasses: 1, browserCrawls: 1 });
  assert.deepEqual(report.lanes.RETRY, { inspectionPasses: 1, browserCrawls: 2 });
  assert.deepEqual(report.lanes.MAINTENANCE, { inspectionPasses: 1, browserCrawls: 1 });
  assert.deepEqual(report.lanes.ENRICHMENT, { inspectionPasses: 1, browserCrawls: 0 });

  // 4 rendered crawls over the 1.5 elapsed hours from 11:00 to 12:30.
  assert.equal(report.gates.elapsedHours, 1.5);
  assert.equal(report.gates.observedBrowserCrawlsPerHour, 2.67);
  assert.equal(report.gates.peakBrowserCrawlsPerHour, 3);
  assert.equal(report.gates.nominalTargetMet, false);
  assert.equal(report.gates.discoveryFloorMet, false);
  assert.deepEqual(report.failures, [
    'browser_crawls_per_hour_below_nominal_target',
    'discovery_share_below_floor',
  ]);
});

test('report does not fabricate a rate when no browser crawl exists', () => {
  const report = buildCrawlThroughputReport([], {
    windowHours: 2,
    now: new Date('2026-11-10T12:30:00.000Z'),
  });

  assert.equal(report.totals.inspectionPasses, 0);
  assert.equal(report.totals.browserCrawls, 0);
  assert.equal(report.gates.observedBrowserCrawlsPerHour, 0);
  assert.equal(report.gates.discoverySharePct, null);
  assert.equal(report.totals.gateWait.averageMs, null);
  assert.equal(report.totals.gateWait.maxMs, null);
  assert.deepEqual(report.failures, ['no_browser_crawl_data']);
});

test('report flags the emergency ceiling and the discovery floor independently', () => {
  const rows: CrawlThroughputEventRow[] = [];
  for (let index = 0; index < 10; index++) {
    rows.push(row(
      `2026-11-10T12:${String(index).padStart(2, '0')}:00.000Z`,
      'DISCOVERY',
      'ACQUIRED',
      { renderedCrawls: 1 },
    ));
  }
  for (let index = 10; index < 50; index++) {
    rows.push(row(
      `2026-11-10T12:${String(index).padStart(2, '0')}:00.000Z`,
      'RETRY',
      'ACQUIRED',
      { renderedCrawls: 1 },
    ));
  }

  const report = buildCrawlThroughputReport(rows, {
    windowHours: 1,
    now: new Date('2026-11-10T12:59:00.000Z'),
  });

  assert.equal(report.totals.browserCrawls, 50);
  assert.equal(report.gates.peakBrowserCrawlsPerHour, 50);
  assert.equal(report.gates.emergencyCeilingExceeded, true);
  assert.equal(report.gates.discoverySharePct, 20);
  assert.equal(report.gates.discoveryFloorMet, false);
  assert.ok(report.failures.includes('peak_browser_crawls_per_hour_above_emergency_ceiling'));
  assert.ok(report.failures.includes('discovery_share_below_floor'));
  assert.ok(!report.failures.includes('browser_crawls_per_hour_below_nominal_target'));
});

test('zero-work and pre-crawl INCONCLUSIVE rows never count as browser crawls', () => {
  const report = buildCrawlThroughputReport([
    row('2026-11-10T12:01:00.000Z', 'RETRY', 'CAPACITY_DEFERRED', { renderedCrawls: 0 }),
    row('2026-11-10T12:02:00.000Z', 'RETRY', 'RUNTIME_UNAVAILABLE', { renderedCrawls: 0 }),
    row('2026-11-10T12:03:00.000Z', 'ENRICHMENT', 'NEVER_EXECUTED', { renderedCrawls: 0 }),
    // A country rejection after the execution marker but before the browser
    // starts is INCONCLUSIVE with no rendered observation.
    row('2026-11-10T12:04:00.000Z', 'DISCOVERY', 'INCONCLUSIVE', { renderedCrawls: 0 }),
    row('2026-11-10T12:05:00.000Z', 'DISCOVERY', 'ACQUIRED', { renderedCrawls: 1 }),
  ], {
    windowHours: 1,
    now: new Date('2026-11-10T12:30:00.000Z'),
  });

  assert.equal(report.totals.inspectionPasses, 5);
  assert.equal(report.totals.browserCrawls, 1);
  assert.equal(report.totals.deferredPasses, 1);
  assert.equal(report.totals.runtimeUnavailablePasses, 1);
  assert.equal(report.totals.neverExecutedPasses, 1);
  assert.equal(report.totals.inconclusivePasses, 1);
  assert.equal(report.totals.completedPasses, 1);
  assert.equal(report.gates.discoverySharePct, 100);
  assert.equal(report.gates.discoveryFloorMet, true);
  assert.deepEqual(report.failures, ['browser_crawls_per_hour_below_nominal_target']);
});

test('unknown lanes and unmetered rows stay visible instead of disappearing', () => {
  const report = buildCrawlThroughputReport([
    row('2026-11-10T10:59:00.000Z', 'DISCOVERY', 'ACQUIRED', { renderedCrawls: 1 }),
    row('2026-11-10T12:31:00.000Z', 'DISCOVERY', 'ACQUIRED', { renderedCrawls: 1 }),
    { ...row('not-a-date', 'DISCOVERY', 'ACQUIRED'), observed_at: 'not-a-date' },
    row('2026-11-10T12:05:00.000Z', 'NOT_A_LANE', 'ACQUIRED', { renderedCrawls: 2 }),
    row('2026-11-10T12:06:00.000Z', 'DISCOVERY', 'NOT_AN_OUTCOME', { renderedCrawls: 1 }),
    row('2026-11-10T12:07:00.000Z', 'DISCOVERY', 'ACQUIRED', { omitDetail: true }),
    row('2026-11-10T12:08:00.000Z', 'MAINTENANCE', 'ACQUIRED', { renderedCrawls: 1 }),
  ], {
    windowHours: 2,
    now: new Date('2026-11-10T12:30:00.000Z'),
  });

  assert.equal(report.totals.inspectionPasses, 4);
  assert.equal(report.totals.browserCrawls, 4);
  assert.equal(report.totals.discoveryBrowserCrawls, 1);
  assert.equal(report.totals.unknownBrowserCrawls, 2);
  assert.equal(report.totals.maintenanceBrowserCrawls, 1);
  assert.equal(report.totals.unmeteredPasses, 1);
  assert.equal(report.totals.discoverySharePct, 25);
  assert.deepEqual(report.lanes.UNKNOWN, { inspectionPasses: 1, browserCrawls: 2 });
  assert.deepEqual(report.warnings, [
    'invalid_timestamp_rows:1',
    'out_of_window_rows:2',
    'unknown_lane_rows:1',
    'unknown_outcome_rows:1',
    'unmetered_rendered_crawl_rows:1',
  ]);
});

test('window start is the exact first UTC hour bucket', () => {
  assert.equal(
    crawlThroughputWindowStart(new Date('2026-11-10T12:30:00.000Z'), 24).toISOString(),
    '2026-11-09T13:00:00.000Z',
  );
  assert.equal(
    crawlThroughputWindowStart(new Date('2026-11-10T00:00:00.000Z'), 1).toISOString(),
    '2026-11-10T00:00:00.000Z',
  );
  // Out-of-range windows clamp exactly like the report.
  assert.equal(
    crawlThroughputWindowStart(new Date('2026-11-10T12:30:00.000Z'), 0).toISOString(),
    '2026-11-10T12:00:00.000Z',
  );
});

test('the report keeps the approved Option C thresholds', () => {
  assert.equal(PHASE2_NOMINAL_CRAWLS_PER_HOUR, 40);
  assert.equal(PHASE2_EMERGENCY_CRAWLS_PER_HOUR, 48);
  assert.equal(PHASE2_DISCOVERY_FLOOR_PERCENT, 35);
});

test('argument parsing is strict and bounded', () => {
  assert.deepEqual(parsePhase2CrawlThroughputReportArgs([]), {
    windowHours: 24,
    check: false,
    out: null,
    help: false,
  });
  assert.deepEqual(parsePhase2CrawlThroughputReportArgs([
    '--window-hours=6',
    '--check',
    '--out=report.json',
  ]), {
    windowHours: 6,
    check: true,
    out: 'report.json',
    help: false,
  });
  assert.equal(parsePhase2CrawlThroughputReportArgs(['--help']).help, true);
  assert.throws(() => parsePhase2CrawlThroughputReportArgs(['--window-hours']), /unknown argument/);
  assert.throws(() => parsePhase2CrawlThroughputReportArgs(['--window-hours=0']), /--window-hours/);
  assert.throws(
    () => parsePhase2CrawlThroughputReportArgs([`--window-hours=${PHASE2_REPORT_MAX_WINDOW_HOURS + 1}`]),
    /--window-hours/,
  );
  assert.throws(() => parsePhase2CrawlThroughputReportArgs(['--out=']), /--out/);
  assert.throws(() => parsePhase2CrawlThroughputReportArgs(['--check=true']), /unknown argument/);
});

test('the production image enables the durable writer and the local example stays opt-in', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(dockerfile, /ACQUISITION_LANE_TELEMETRY_ENABLED=true/);
  assert.match(example, /ACQUISITION_LANE_TELEMETRY_ENABLED="false"/);
});
