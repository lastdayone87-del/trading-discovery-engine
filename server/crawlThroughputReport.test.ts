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

function row(
  observedAt: string,
  lane: string,
  outcome: string,
  extra: Partial<CrawlThroughputEventRow> = {},
): CrawlThroughputEventRow {
  return {
    observed_at: observedAt,
    lane,
    outcome,
    gate_wait_ms: null,
    pages_inspected: 0,
    requests_started: 0,
    capacity_event: null,
    ...extra,
  };
}

test('report fills every hour bucket and separates capacity crawls from maintenance', () => {
  const report = buildCrawlThroughputReport([
    row('2026-11-10T11:10:00.000Z', 'DISCOVERY', 'ACQUIRED', { gate_wait_ms: 1200 }),
    row('2026-11-10T11:40:00.000Z', 'RETRY', 'PARTIALLY_INSPECTED', { pages_inspected: 2 }),
    row('2026-11-10T12:10:00.000Z', 'ENRICHMENT', 'CAPACITY_DEFERRED'),
    row('2026-11-10T12:20:00.000Z', 'MAINTENANCE', 'NEVER_EXECUTED'),
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
  assert.equal(first.events, 2);
  assert.equal(first.crawlAttempts, 2);
  assert.equal(first.capacityCrawlAttempts, 2);
  assert.equal(first.discoveryCrawlAttempts, 1);
  assert.equal(first.completed, 2);
  assert.equal(first.discoverySharePct, 50);
  assert.deepEqual(first.gateWait, { samples: 1, averageMs: 1200, maxMs: 1200 });

  const second = report.buckets[1];
  assert.equal(second.events, 2);
  assert.equal(second.crawlAttempts, 0);
  assert.equal(second.capacityCrawlAttempts, 0);
  assert.equal(second.deferred, 1);
  assert.equal(second.neverExecuted, 1);

  assert.equal(report.totals.events, 4);
  assert.equal(report.totals.crawlAttempts, 2);
  assert.equal(report.totals.capacityCrawlAttempts, 2);
  assert.equal(report.totals.discoveryCrawlAttempts, 1);
  assert.equal(report.totals.otherLaneAttempts, 0);
  assert.equal(report.totals.completed, 2);
  assert.equal(report.totals.deferred, 1);
  assert.equal(report.totals.neverExecuted, 1);

  // 2 crawls over the 1.5 elapsed hours from 11:00 to 12:30.
  assert.equal(report.gates.elapsedHours, 1.5);
  assert.equal(report.gates.observedCrawlsPerHour, 1.33);
  assert.equal(report.gates.peakCrawlsPerHour, 2);
  assert.equal(report.gates.discoverySharePct, 50);
  assert.equal(report.gates.nominalTargetMet, false);
  assert.equal(report.gates.discoveryFloorMet, true);
  assert.deepEqual(report.failures, ['crawls_per_hour_below_nominal_target']);
});

test('report does not fabricate a rate when no capacity crawl exists', () => {
  const report = buildCrawlThroughputReport([], {
    windowHours: 2,
    now: new Date('2026-11-10T12:30:00.000Z'),
  });

  assert.equal(report.totals.events, 0);
  assert.equal(report.gates.observedCrawlsPerHour, 0);
  assert.equal(report.gates.discoverySharePct, null);
  assert.equal(report.totals.gateWait.averageMs, null);
  assert.equal(report.totals.gateWait.maxMs, null);
  assert.deepEqual(report.failures, ['no_capacity_crawl_data']);
});

test('report flags the emergency ceiling and the discovery floor independently', () => {
  const rows: CrawlThroughputEventRow[] = [];
  for (let index = 0; index < 10; index++) {
    rows.push(row(`2026-11-10T12:${String(index).padStart(2, '0')}:00.000Z`, 'DISCOVERY', 'ACQUIRED'));
  }
  for (let index = 10; index < 50; index++) {
    rows.push(row(`2026-11-10T12:${String(index).padStart(2, '0')}:00.000Z`, 'RETRY', 'ACQUIRED'));
  }

  const report = buildCrawlThroughputReport(rows, {
    windowHours: 1,
    now: new Date('2026-11-10T12:59:00.000Z'),
  });

  assert.equal(report.totals.capacityCrawlAttempts, 50);
  assert.equal(report.gates.peakCrawlsPerHour, 50);
  assert.equal(report.gates.emergencyCeilingExceeded, true);
  assert.equal(report.gates.discoverySharePct, 20);
  assert.equal(report.gates.discoveryFloorMet, false);
  assert.ok(report.failures.includes('peak_crawls_per_hour_above_emergency_ceiling'));
  assert.ok(report.failures.includes('discovery_share_below_floor'));
  assert.ok(!report.failures.includes('crawls_per_hour_below_nominal_target'));
});

test('no-work outcomes are reported but never counted as crawls', () => {
  const report = buildCrawlThroughputReport([
    row('2026-11-10T12:01:00.000Z', 'RETRY', 'CAPACITY_DEFERRED'),
    row('2026-11-10T12:02:00.000Z', 'RETRY', 'RUNTIME_UNAVAILABLE'),
    row('2026-11-10T12:03:00.000Z', 'ENRICHMENT', 'NEVER_EXECUTED'),
    row('2026-11-10T12:04:00.000Z', 'DISCOVERY', 'ACQUIRED'),
  ], {
    windowHours: 1,
    now: new Date('2026-11-10T12:30:00.000Z'),
  });

  assert.equal(report.totals.events, 4);
  assert.equal(report.totals.crawlAttempts, 1);
  assert.equal(report.totals.capacityCrawlAttempts, 1);
  assert.equal(report.totals.deferred, 1);
  assert.equal(report.totals.runtimeUnavailable, 1);
  assert.equal(report.totals.neverExecuted, 1);
  assert.equal(report.gates.discoverySharePct, 100);
  assert.equal(report.gates.discoveryFloorMet, true);
  assert.deepEqual(report.failures, ['crawls_per_hour_below_nominal_target']);
});

test('report ignores malformed and out-of-window rows with bounded warnings', () => {
  const report = buildCrawlThroughputReport([
    row('2026-11-10T10:59:00.000Z', 'DISCOVERY', 'ACQUIRED'),
    row('2026-11-10T12:31:00.000Z', 'DISCOVERY', 'ACQUIRED'),
    row('not-a-date', 'DISCOVERY', 'ACQUIRED'),
    row('2026-11-10T12:05:00.000Z', 'NOT_A_LANE', 'ACQUIRED'),
    row('2026-11-10T12:06:00.000Z', 'DISCOVERY', 'NOT_AN_OUTCOME'),
  ], {
    windowHours: 2,
    now: new Date('2026-11-10T12:30:00.000Z'),
  });

  assert.equal(report.totals.events, 0);
  assert.equal(report.totals.capacityCrawlAttempts, 0);
  assert.deepEqual(report.warnings, [
    'invalid_timestamp_rows:1',
    'out_of_window_rows:2',
    'unknown_lane_rows:1',
    'unknown_outcome_rows:1',
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

test('the production image and documented environment enable the durable writer', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(dockerfile, /ACQUISITION_LANE_TELEMETRY_ENABLED=true/);
  assert.match(example, /ACQUISITION_LANE_TELEMETRY_ENABLED="true"/);
});
