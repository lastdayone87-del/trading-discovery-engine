/**
 * Phase 2 Option C crawl-throughput report (pure).
 *
 * The report is derived from the append-only `acquisition_lane_events`
 * baseline. It deliberately separates capacity-lane crawls (DISCOVERY,
 * ENRICHMENT, RETRY, MANUAL) from maintenance events: maintenance jobs are
 * DB-local and must not consume the single browser-slot budget.
 *
 * Two gates are reported:
 *   * capacity crawls/hour against the 40/h nominal target and the 48/h
 *     emergency ceiling; and
 *   * the DISCOVERY share of capacity crawls against the 35% floor.
 *
 * An event counts as a crawl attempt unless the outcome proves no crawl
 * started (NEVER_EXECUTED, CAPACITY_DEFERRED, RUNTIME_UNAVAILABLE). A failed
 * or inconclusive crawl still consumed slot time and therefore counts.
 */

export const PHASE2_NOMINAL_CRAWLS_PER_HOUR = 40;
export const PHASE2_EMERGENCY_CRAWLS_PER_HOUR = 48;
export const PHASE2_DISCOVERY_FLOOR_PERCENT = 35;
export const PHASE2_REPORT_DEFAULT_WINDOW_HOURS = 24;
export const PHASE2_REPORT_MAX_WINDOW_HOURS = 168;

const HOUR_MS = 60 * 60 * 1000;

const CAPACITY_LANES = new Set(['DISCOVERY', 'ENRICHMENT', 'RETRY', 'MANUAL']);
const KNOWN_LANES = new Set([...CAPACITY_LANES, 'MAINTENANCE', 'UNKNOWN']);
const KNOWN_OUTCOMES = new Set([
  'ACQUIRED',
  'INSPECTED_NO_MATCH',
  'PARTIALLY_INSPECTED',
  'EXTERNALLY_BLOCKED',
  'ACQUISITION_FAILED',
  'CAPACITY_DEFERRED',
  'RUNTIME_UNAVAILABLE',
  'NEVER_EXECUTED',
  'INCONCLUSIVE',
]);
const NO_CRAWL_OUTCOMES = new Set(['NEVER_EXECUTED', 'CAPACITY_DEFERRED', 'RUNTIME_UNAVAILABLE']);
const COMPLETED_OUTCOMES = new Set([
  'ACQUIRED',
  'INSPECTED_NO_MATCH',
  'PARTIALLY_INSPECTED',
  'EXTERNALLY_BLOCKED',
]);

export interface CrawlThroughputEventRow {
  observed_at?: unknown;
  lane?: unknown;
  outcome?: unknown;
  gate_wait_ms?: unknown;
  pages_inspected?: unknown;
  requests_started?: unknown;
  capacity_event?: unknown;
}

export interface CrawlThroughputBucket {
  /** ISO timestamp for the start of the UTC hour. */
  hour: string;
  events: number;
  crawlAttempts: number;
  capacityCrawlAttempts: number;
  discoveryCrawlAttempts: number;
  completed: number;
  failed: number;
  deferred: number;
  runtimeUnavailable: number;
  inconclusive: number;
  neverExecuted: number;
  discoverySharePct: number | null;
  gateWait: {
    samples: number;
    averageMs: number | null;
    maxMs: number | null;
  };
}

export interface CrawlThroughputTotals {
  events: number;
  crawlAttempts: number;
  capacityCrawlAttempts: number;
  discoveryCrawlAttempts: number;
  otherLaneAttempts: number;
  completed: number;
  failed: number;
  deferred: number;
  runtimeUnavailable: number;
  inconclusive: number;
  neverExecuted: number;
  discoverySharePct: number | null;
  gateWait: {
    samples: number;
    averageMs: number | null;
    maxMs: number | null;
  };
}

export interface CrawlThroughputGates {
  nominalTargetPerHour: number;
  emergencyCeilingPerHour: number;
  discoveryFloorPct: number;
  elapsedHours: number;
  observedCrawlsPerHour: number;
  peakCrawlsPerHour: number;
  discoverySharePct: number | null;
  nominalTargetMet: boolean;
  emergencyCeilingExceeded: boolean;
  discoveryFloorMet: boolean;
}

export interface CrawlThroughputReport {
  generatedAt: string;
  windowHours: number;
  windowStart: string;
  totals: CrawlThroughputTotals;
  buckets: CrawlThroughputBucket[];
  gates: CrawlThroughputGates;
  failures: string[];
  warnings: string[];
}

export interface CrawlThroughputReportOptions {
  windowHours?: number;
  now?: Date;
  nominalTargetPerHour?: number;
  emergencyCeilingPerHour?: number;
  discoveryFloorPct?: number;
}

export interface CrawlThroughputReportArgs {
  windowHours: number;
  check: boolean;
  out: string | null;
  help: boolean;
}

export const PHASE2_CRAWL_THROUGHPUT_USAGE =
  'Usage: npx tsx scripts/phase2CrawlThroughputReport.ts '
  + '[--window-hours=24] [--check] [--out=path]';

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function numeric(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function isoHour(ms: number): string {
  return new Date(ms).toISOString();
}

function percent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10000) / 100;
}

function average(sum: number, samples: number): number | null {
  if (samples <= 0) return null;
  return Math.round(sum / samples);
}

function parseBoundedInteger(rawValue: string, flag: string, min: number, max: number): number {
  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}: "${rawValue}"`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}: "${rawValue}"`);
  }
  return value;
}

/**
 * Strict argument parsing: unknown or malformed tokens fail instead of being
 * silently ignored. A bare `--window-hours` must not be treated as a default.
 */
/**
 * First UTC hour bucket included by the report. The current hour is partial;
 * the window includes it plus the preceding `windowHours - 1` hours.
 */
export function crawlThroughputWindowStart(now: Date, windowHours?: number): Date {
  const hours = boundedInteger(
    windowHours,
    PHASE2_REPORT_DEFAULT_WINDOW_HOURS,
    1,
    PHASE2_REPORT_MAX_WINDOW_HOURS,
  );
  const currentHourMs = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  return new Date(currentHourMs - (hours - 1) * HOUR_MS);
}

export function parsePhase2CrawlThroughputReportArgs(
  argv: readonly string[],
): CrawlThroughputReportArgs {
  const args: CrawlThroughputReportArgs = {
    windowHours: PHASE2_REPORT_DEFAULT_WINDOW_HOURS,
    check: false,
    out: null,
    help: false,
  };
  for (const raw of argv) {
    if (raw === '--check') args.check = true;
    else if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw.startsWith('--window-hours=')) {
      args.windowHours = parseBoundedInteger(
        raw.slice('--window-hours='.length),
        '--window-hours',
        1,
        PHASE2_REPORT_MAX_WINDOW_HOURS,
      );
    } else if (raw.startsWith('--out=')) {
      const out = raw.slice('--out='.length);
      if (!out.trim()) throw new Error('--out must name a non-empty file path');
      args.out = out;
    } else {
      throw new Error(`unknown argument: "${raw}". ${PHASE2_CRAWL_THROUGHPUT_USAGE}`);
    }
  }
  return args;
}

interface MutableBucket {
  hourMs: number;
  events: number;
  crawlAttempts: number;
  capacityCrawlAttempts: number;
  discoveryCrawlAttempts: number;
  completed: number;
  failed: number;
  deferred: number;
  runtimeUnavailable: number;
  inconclusive: number;
  neverExecuted: number;
  gateWaitSamples: number;
  gateWaitSum: number;
  gateWaitMax: number;
}

function emptyBucket(hourMs: number): MutableBucket {
  return {
    hourMs,
    events: 0,
    crawlAttempts: 0,
    capacityCrawlAttempts: 0,
    discoveryCrawlAttempts: 0,
    completed: 0,
    failed: 0,
    deferred: 0,
    runtimeUnavailable: 0,
    inconclusive: 0,
    neverExecuted: 0,
    gateWaitSamples: 0,
    gateWaitSum: 0,
    gateWaitMax: 0,
  };
}

function finalizeBucket(bucket: MutableBucket): CrawlThroughputBucket {
  return {
    hour: isoHour(bucket.hourMs),
    events: bucket.events,
    crawlAttempts: bucket.crawlAttempts,
    capacityCrawlAttempts: bucket.capacityCrawlAttempts,
    discoveryCrawlAttempts: bucket.discoveryCrawlAttempts,
    completed: bucket.completed,
    failed: bucket.failed,
    deferred: bucket.deferred,
    runtimeUnavailable: bucket.runtimeUnavailable,
    inconclusive: bucket.inconclusive,
    neverExecuted: bucket.neverExecuted,
    discoverySharePct: percent(bucket.discoveryCrawlAttempts, bucket.capacityCrawlAttempts),
    gateWait: {
      samples: bucket.gateWaitSamples,
      averageMs: average(bucket.gateWaitSum, bucket.gateWaitSamples),
      maxMs: bucket.gateWaitSamples > 0 ? bucket.gateWaitMax : null,
    },
  };
}

export function buildCrawlThroughputReport(
  rows: readonly CrawlThroughputEventRow[],
  options: CrawlThroughputReportOptions = {},
): CrawlThroughputReport {
  const now = options.now instanceof Date && Number.isFinite(options.now.getTime())
    ? options.now
    : new Date();
  const nowMs = now.getTime();
  const windowHours = boundedInteger(
    options.windowHours,
    PHASE2_REPORT_DEFAULT_WINDOW_HOURS,
    1,
    PHASE2_REPORT_MAX_WINDOW_HOURS,
  );
  const nominalTargetPerHour = numeric(options.nominalTargetPerHour ?? PHASE2_NOMINAL_CRAWLS_PER_HOUR);
  const emergencyCeilingPerHour = numeric(options.emergencyCeilingPerHour ?? PHASE2_EMERGENCY_CRAWLS_PER_HOUR);
  const discoveryFloorPct = numeric(options.discoveryFloorPct ?? PHASE2_DISCOVERY_FLOOR_PERCENT);

  const startHourMs = crawlThroughputWindowStart(now, windowHours).getTime();
  const currentHourMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  // The current UTC hour is intentionally partial. Use elapsed wall time so a
  // report run at 09:05 is not divided by a full 24 hours.
  const elapsedHours = Math.max(1 / 60, (nowMs - startHourMs) / HOUR_MS);

  const buckets = new Map<number, MutableBucket>();
  for (let hourMs = startHourMs; hourMs <= currentHourMs; hourMs += HOUR_MS) {
    buckets.set(hourMs, emptyBucket(hourMs));
  }

  let ignoredOutOfWindow = 0;
  let invalidTimestamp = 0;
  let unknownLane = 0;
  let unknownOutcome = 0;
  let totalGateWaitSamples = 0;
  let totalGateWaitSum = 0;
  let totalGateWaitMax = 0;

  for (const row of rows) {
    const observedMs = typeof row.observed_at === 'string' || row.observed_at instanceof Date
      ? new Date(row.observed_at).getTime()
      : Number.NaN;
    if (!Number.isFinite(observedMs)) {
      invalidTimestamp += 1;
      continue;
    }
    if (observedMs < startHourMs || observedMs > nowMs) {
      ignoredOutOfWindow += 1;
      continue;
    }

    const lane = String(row.lane || '').trim().toUpperCase();
    const outcome = String(row.outcome || '').trim().toUpperCase();
    if (!KNOWN_LANES.has(lane)) {
      unknownLane += 1;
      continue;
    }
    if (!KNOWN_OUTCOMES.has(outcome)) {
      unknownOutcome += 1;
      continue;
    }

    const hourMs = Math.floor(observedMs / HOUR_MS) * HOUR_MS;
    const bucket = buckets.get(hourMs);
    if (!bucket) {
      ignoredOutOfWindow += 1;
      continue;
    }

    bucket.events += 1;
    const capacityLane = CAPACITY_LANES.has(lane);
    const noCrawl = NO_CRAWL_OUTCOMES.has(outcome);
    if (!noCrawl) {
      bucket.crawlAttempts += 1;
      if (capacityLane) {
        bucket.capacityCrawlAttempts += 1;
        if (lane === 'DISCOVERY') bucket.discoveryCrawlAttempts += 1;
      }
    }

    if (outcome === 'CAPACITY_DEFERRED') bucket.deferred += 1;
    else if (outcome === 'RUNTIME_UNAVAILABLE') bucket.runtimeUnavailable += 1;
    else if (outcome === 'NEVER_EXECUTED') bucket.neverExecuted += 1;
    else if (outcome === 'INCONCLUSIVE') bucket.inconclusive += 1;
    else if (outcome === 'ACQUISITION_FAILED') bucket.failed += 1;
    else if (COMPLETED_OUTCOMES.has(outcome)) bucket.completed += 1;

    const gateWaitMs = numeric(row.gate_wait_ms);
    if (gateWaitMs > 0) {
      bucket.gateWaitSamples += 1;
      bucket.gateWaitSum += gateWaitMs;
      bucket.gateWaitMax = Math.max(bucket.gateWaitMax, gateWaitMs);
      totalGateWaitSamples += 1;
      totalGateWaitSum += gateWaitMs;
      totalGateWaitMax = Math.max(totalGateWaitMax, gateWaitMs);
    }
  }

  const finalized = [...buckets.values()]
    .sort((left, right) => left.hourMs - right.hourMs)
    .map(finalizeBucket);

  const totals = finalized.reduce<CrawlThroughputTotals>((acc, bucket) => {
    acc.events += bucket.events;
    acc.crawlAttempts += bucket.crawlAttempts;
    acc.capacityCrawlAttempts += bucket.capacityCrawlAttempts;
    acc.discoveryCrawlAttempts += bucket.discoveryCrawlAttempts;
    acc.otherLaneAttempts += bucket.crawlAttempts - bucket.capacityCrawlAttempts;
    acc.completed += bucket.completed;
    acc.failed += bucket.failed;
    acc.deferred += bucket.deferred;
    acc.runtimeUnavailable += bucket.runtimeUnavailable;
    acc.inconclusive += bucket.inconclusive;
    acc.neverExecuted += bucket.neverExecuted;
    acc.gateWait.samples += bucket.gateWait.samples;
    acc.gateWait.maxMs = Math.max(acc.gateWait.maxMs ?? 0, bucket.gateWait.maxMs ?? 0);
    return acc;
  }, {
    events: 0,
    crawlAttempts: 0,
    capacityCrawlAttempts: 0,
    discoveryCrawlAttempts: 0,
    otherLaneAttempts: 0,
    completed: 0,
    failed: 0,
    deferred: 0,
    runtimeUnavailable: 0,
    inconclusive: 0,
    neverExecuted: 0,
    discoverySharePct: null,
    gateWait: { samples: 0, averageMs: null, maxMs: null },
  });

  totals.gateWait.averageMs = average(totalGateWaitSum, totalGateWaitSamples);
  totals.gateWait.maxMs = totalGateWaitSamples > 0 ? totalGateWaitMax : null;
  totals.discoverySharePct = percent(totals.discoveryCrawlAttempts, totals.capacityCrawlAttempts);

  const peakCrawlsPerHour = finalized.reduce(
    (max, bucket) => Math.max(max, bucket.capacityCrawlAttempts),
    0,
  );
  const observedCrawlsPerHour = Math.round((totals.capacityCrawlAttempts / elapsedHours) * 100) / 100;
  const discoverySharePct = totals.discoverySharePct;
  const nominalTargetMet = totals.capacityCrawlAttempts > 0 && observedCrawlsPerHour >= nominalTargetPerHour;
  const emergencyCeilingExceeded = peakCrawlsPerHour > emergencyCeilingPerHour;
  const discoveryFloorMet = discoverySharePct !== null && discoverySharePct >= discoveryFloorPct;

  const failures: string[] = [];
  if (totals.capacityCrawlAttempts === 0) {
    failures.push('no_capacity_crawl_data');
  } else {
    if (!nominalTargetMet) failures.push('crawls_per_hour_below_nominal_target');
    if (!discoveryFloorMet) failures.push('discovery_share_below_floor');
  }
  if (emergencyCeilingExceeded) failures.push('peak_crawls_per_hour_above_emergency_ceiling');

  const warnings: string[] = [];
  if (invalidTimestamp > 0) warnings.push(`invalid_timestamp_rows:${invalidTimestamp}`);
  if (ignoredOutOfWindow > 0) warnings.push(`out_of_window_rows:${ignoredOutOfWindow}`);
  if (unknownLane > 0) warnings.push(`unknown_lane_rows:${unknownLane}`);
  if (unknownOutcome > 0) warnings.push(`unknown_outcome_rows:${unknownOutcome}`);

  return {
    generatedAt: now.toISOString(),
    windowHours,
    windowStart: isoHour(startHourMs),
    totals,
    buckets: finalized,
    gates: {
      nominalTargetPerHour,
      emergencyCeilingPerHour,
      discoveryFloorPct,
      elapsedHours: Math.round(elapsedHours * 100) / 100,
      observedCrawlsPerHour,
      peakCrawlsPerHour,
      discoverySharePct,
      nominalTargetMet,
      emergencyCeilingExceeded,
      discoveryFloorMet,
    },
    failures,
    warnings,
  };
}
