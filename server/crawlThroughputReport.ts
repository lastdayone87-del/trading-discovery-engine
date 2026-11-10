/**
 * Phase 2 Option C crawl-throughput report (pure).
 *
 * The report is derived from the append-only `acquisition_lane_events`
 * baseline. One lane event is one inspection pass; `detail.renderedCrawls`
 * records how many unique seed URLs actually ran the rendered browser crawler
 * in that pass. Static HTTP observations are deliberately not browser crawls.
 *
 * Two gates are reported:
 *   * rendered browser crawls/hour against the 40/h nominal target and the
 *     48/h emergency ceiling; and
 *   * the DISCOVERY share of rendered browser crawls against the 35% floor.
 *
 * Every lane is included in the browser-crawl total, including MAINTENANCE
 * (recovery workers can invoke the browser fallback) and UNKNOWN. Those lanes
 * are separately counted so no browser work can hide from the ceiling.
 */

export const PHASE2_NOMINAL_CRAWLS_PER_HOUR = 40;
export const PHASE2_EMERGENCY_CRAWLS_PER_HOUR = 48;
export const PHASE2_DISCOVERY_FLOOR_PERCENT = 35;
export const PHASE2_REPORT_DEFAULT_WINDOW_HOURS = 24;
export const PHASE2_REPORT_MAX_WINDOW_HOURS = 168;

const HOUR_MS = 60 * 60 * 1000;

const KNOWN_LANES = new Set([
  'DISCOVERY',
  'ENRICHMENT',
  'RETRY',
  'MANUAL',
  'MAINTENANCE',
  'UNKNOWN',
]);
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
  detail?: unknown;
}

export interface CrawlThroughputBucket {
  /** ISO timestamp for the start of the UTC hour. */
  hour: string;
  inspectionPasses: number;
  browserCrawls: number;
  discoveryBrowserCrawls: number;
  completedPasses: number;
  failedPasses: number;
  deferredPasses: number;
  runtimeUnavailablePasses: number;
  inconclusivePasses: number;
  neverExecutedPasses: number;
  discoverySharePct: number | null;
  gateWait: {
    samples: number;
    averageMs: number | null;
    maxMs: number | null;
  };
}

export interface CrawlThroughputTotals {
  inspectionPasses: number;
  browserCrawls: number;
  discoveryBrowserCrawls: number;
  maintenanceBrowserCrawls: number;
  unknownBrowserCrawls: number;
  completedPasses: number;
  failedPasses: number;
  deferredPasses: number;
  runtimeUnavailablePasses: number;
  inconclusivePasses: number;
  neverExecutedPasses: number;
  /** Passes whose row predates or lacks a trustworthy `renderedCrawls`. */
  unmeteredPasses: number;
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
  observedBrowserCrawlsPerHour: number;
  peakBrowserCrawlsPerHour: number;
  discoverySharePct: number | null;
  nominalTargetMet: boolean;
  emergencyCeilingExceeded: boolean;
  discoveryFloorMet: boolean;
}

export type CrawlThroughputLane = 'DISCOVERY' | 'ENRICHMENT' | 'RETRY' | 'MANUAL' | 'MAINTENANCE' | 'UNKNOWN';

export type CrawlThroughputLaneTotals = Record<CrawlThroughputLane, {
  inspectionPasses: number;
  browserCrawls: number;
}>;

export interface CrawlThroughputReport {
  generatedAt: string;
  windowHours: number;
  windowStart: string;
  lanes: CrawlThroughputLaneTotals;
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

function renderedCrawlsFromRow(row: CrawlThroughputEventRow): {
  value: number;
  metered: boolean;
  startedAt: string[];
} {
  const detail = row.detail;
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
    return { value: 0, metered: false, startedAt: [] };
  }
  const raw = (detail as Record<string, unknown>).renderedCrawls;
  // JSONB numbers arrive as numbers. Never coerce strings, null, booleans, or
  // fractional values into a crawl count; mark the pass unmetered instead.
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    return { value: 0, metered: false, startedAt: [] };
  }
  const rawStartedAt = (detail as Record<string, unknown>).renderedCrawlStartedAt;
  const startedAt = Array.isArray(rawStartedAt)
    ? rawStartedAt
      .filter((item): item is string => typeof item === 'string' && Number.isFinite(Date.parse(item)))
      .slice(0, 32)
      .map(item => new Date(item).toISOString())
    : [];
  return { value: raw, metered: true, startedAt };
}

interface MutableBucket {
  hourMs: number;
  inspectionPasses: number;
  browserCrawls: number;
  discoveryBrowserCrawls: number;
  completedPasses: number;
  failedPasses: number;
  deferredPasses: number;
  runtimeUnavailablePasses: number;
  inconclusivePasses: number;
  neverExecutedPasses: number;
  gateWaitSamples: number;
  gateWaitSum: number;
  gateWaitMax: number;
}

function emptyBucket(hourMs: number): MutableBucket {
  return {
    hourMs,
    inspectionPasses: 0,
    browserCrawls: 0,
    discoveryBrowserCrawls: 0,
    completedPasses: 0,
    failedPasses: 0,
    deferredPasses: 0,
    runtimeUnavailablePasses: 0,
    inconclusivePasses: 0,
    neverExecutedPasses: 0,
    gateWaitSamples: 0,
    gateWaitSum: 0,
    gateWaitMax: 0,
  };
}

function finalizeBucket(bucket: MutableBucket): CrawlThroughputBucket {
  return {
    hour: isoHour(bucket.hourMs),
    inspectionPasses: bucket.inspectionPasses,
    browserCrawls: bucket.browserCrawls,
    discoveryBrowserCrawls: bucket.discoveryBrowserCrawls,
    completedPasses: bucket.completedPasses,
    failedPasses: bucket.failedPasses,
    deferredPasses: bucket.deferredPasses,
    runtimeUnavailablePasses: bucket.runtimeUnavailablePasses,
    inconclusivePasses: bucket.inconclusivePasses,
    neverExecutedPasses: bucket.neverExecutedPasses,
    discoverySharePct: percent(bucket.discoveryBrowserCrawls, bucket.browserCrawls),
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
  let unmeteredPasses = 0;
  let totalGateWaitSamples = 0;
  let totalGateWaitSum = 0;
  let totalGateWaitMax = 0;
  let browserCrawls = 0;
  let discoveryBrowserCrawls = 0;
  let maintenanceBrowserCrawls = 0;
  let unknownBrowserCrawls = 0;
  const laneTotals: CrawlThroughputLaneTotals = {
    DISCOVERY: { inspectionPasses: 0, browserCrawls: 0 },
    ENRICHMENT: { inspectionPasses: 0, browserCrawls: 0 },
    RETRY: { inspectionPasses: 0, browserCrawls: 0 },
    MANUAL: { inspectionPasses: 0, browserCrawls: 0 },
    MAINTENANCE: { inspectionPasses: 0, browserCrawls: 0 },
    UNKNOWN: { inspectionPasses: 0, browserCrawls: 0 },
  };

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

    const rawLane = String(row.lane || '').trim().toUpperCase();
    const lane = (KNOWN_LANES.has(rawLane) ? rawLane : 'UNKNOWN') as CrawlThroughputLane;
    if (lane === 'UNKNOWN' && rawLane !== 'UNKNOWN') unknownLane += 1;

    const outcome = String(row.outcome || '').trim().toUpperCase();
    const knownOutcome = KNOWN_OUTCOMES.has(outcome);
    if (!knownOutcome) unknownOutcome += 1;

    const hourMs = Math.floor(observedMs / HOUR_MS) * HOUR_MS;
    const bucket = buckets.get(hourMs);
    if (!bucket) {
      ignoredOutOfWindow += 1;
      continue;
    }

    const rendered = renderedCrawlsFromRow(row);
    if (!rendered.metered) unmeteredPasses += 1;

    bucket.inspectionPasses += 1;
    browserCrawls += rendered.value;
    laneTotals[lane].inspectionPasses += 1;
    laneTotals[lane].browserCrawls += rendered.value;
    if (lane === 'DISCOVERY') {
      discoveryBrowserCrawls += rendered.value;
    } else if (lane === 'MAINTENANCE') {
      maintenanceBrowserCrawls += rendered.value;
    } else if (lane === 'UNKNOWN') {
      unknownBrowserCrawls += rendered.value;
    }

    // Attribute each rendered crawl to its own gate-admission hour when the
    // event carries timestamps. Missing timestamps fall back to the
    // inspection row's hour, so no crawl can disappear from the totals.
    let attributed = 0;
    for (const startedAt of rendered.startedAt.slice(0, rendered.value)) {
      const startedMs = Date.parse(startedAt);
      const startedHourMs = Math.floor(startedMs / HOUR_MS) * HOUR_MS;
      const target = buckets.get(startedHourMs);
      if (!target) continue;
      target.browserCrawls += 1;
      if (lane === 'DISCOVERY') target.discoveryBrowserCrawls += 1;
      attributed += 1;
    }
    const remainder = Math.max(0, rendered.value - attributed);
    bucket.browserCrawls += remainder;
    if (lane === 'DISCOVERY') bucket.discoveryBrowserCrawls += remainder;

    if (knownOutcome) {
      if (outcome === 'CAPACITY_DEFERRED') bucket.deferredPasses += 1;
      else if (outcome === 'RUNTIME_UNAVAILABLE') bucket.runtimeUnavailablePasses += 1;
      else if (outcome === 'NEVER_EXECUTED') bucket.neverExecutedPasses += 1;
      else if (outcome === 'INCONCLUSIVE') bucket.inconclusivePasses += 1;
      else if (outcome === 'ACQUISITION_FAILED') bucket.failedPasses += 1;
      else if (COMPLETED_OUTCOMES.has(outcome)) bucket.completedPasses += 1;
    }

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
    acc.inspectionPasses += bucket.inspectionPasses;
    acc.browserCrawls += bucket.browserCrawls;
    acc.discoveryBrowserCrawls += bucket.discoveryBrowserCrawls;
    acc.completedPasses += bucket.completedPasses;
    acc.failedPasses += bucket.failedPasses;
    acc.deferredPasses += bucket.deferredPasses;
    acc.runtimeUnavailablePasses += bucket.runtimeUnavailablePasses;
    acc.inconclusivePasses += bucket.inconclusivePasses;
    acc.neverExecutedPasses += bucket.neverExecutedPasses;
    acc.gateWait.samples += bucket.gateWait.samples;
    acc.gateWait.maxMs = Math.max(acc.gateWait.maxMs ?? 0, bucket.gateWait.maxMs ?? 0);
    return acc;
  }, {
    inspectionPasses: 0,
    browserCrawls: 0,
    discoveryBrowserCrawls: 0,
    maintenanceBrowserCrawls,
    unknownBrowserCrawls,
    completedPasses: 0,
    failedPasses: 0,
    deferredPasses: 0,
    runtimeUnavailablePasses: 0,
    inconclusivePasses: 0,
    neverExecutedPasses: 0,
    unmeteredPasses,
    discoverySharePct: null,
    gateWait: { samples: 0, averageMs: null, maxMs: null },
  });

  totals.gateWait.averageMs = average(totalGateWaitSum, totalGateWaitSamples);
  totals.gateWait.maxMs = totalGateWaitSamples > 0 ? totalGateWaitMax : null;
  totals.discoverySharePct = percent(totals.discoveryBrowserCrawls, totals.browserCrawls);

  const peakBrowserCrawlsPerHour = finalized.reduce(
    (max, bucket) => Math.max(max, bucket.browserCrawls),
    0,
  );
  const observedBrowserCrawlsPerHour = Math.round((browserCrawls / elapsedHours) * 100) / 100;
  const discoverySharePct = totals.discoverySharePct;
  const nominalTargetMet = browserCrawls > 0 && observedBrowserCrawlsPerHour >= nominalTargetPerHour;
  const emergencyCeilingExceeded = peakBrowserCrawlsPerHour > emergencyCeilingPerHour;
  const discoveryFloorMet = discoverySharePct !== null && discoverySharePct >= discoveryFloorPct;

  const failures: string[] = [];
  if (browserCrawls === 0) {
    failures.push('no_browser_crawl_data');
  } else {
    if (!nominalTargetMet) failures.push('browser_crawls_per_hour_below_nominal_target');
    if (!discoveryFloorMet) failures.push('discovery_share_below_floor');
  }
  if (emergencyCeilingExceeded) failures.push('peak_browser_crawls_per_hour_above_emergency_ceiling');

  const warnings: string[] = [];
  if (invalidTimestamp > 0) warnings.push(`invalid_timestamp_rows:${invalidTimestamp}`);
  if (ignoredOutOfWindow > 0) warnings.push(`out_of_window_rows:${ignoredOutOfWindow}`);
  if (unknownLane > 0) warnings.push(`unknown_lane_rows:${unknownLane}`);
  if (unknownOutcome > 0) warnings.push(`unknown_outcome_rows:${unknownOutcome}`);
  if (unmeteredPasses > 0) warnings.push(`unmetered_rendered_crawl_rows:${unmeteredPasses}`);

  return {
    generatedAt: now.toISOString(),
    windowHours,
    windowStart: isoHour(startHourMs),
    lanes: laneTotals,
    totals,
    buckets: finalized,
    gates: {
      nominalTargetPerHour,
      emergencyCeilingPerHour,
      discoveryFloorPct,
      elapsedHours: Math.round(elapsedHours * 100) / 100,
      observedBrowserCrawlsPerHour,
      peakBrowserCrawlsPerHour,
      discoverySharePct,
      nominalTargetMet,
      emergencyCeilingExceeded,
      discoveryFloorMet,
    },
    failures,
    warnings,
  };
}
