/**
 * Phase 0 acquisition lane telemetry writer.
 *
 * The process-local counters always update; the append-only database baseline
 * is behind `ACQUISITION_LANE_TELEMETRY_ENABLED` (default false). A write
 * failure is observational only and can never change an acquisition result.
 */

import { createHash } from 'node:crypto';
import {
  type AcquisitionAttribution,
  type AcquisitionLaneInspection,
  type AcquisitionLaneRetryDirective,
  type AcquisitionLaneSummary,
  type AcquisitionOutcome,
  isAcquisitionOutcome,
  sanitizeAcquisitionAttribution,
  summarizeAcquisitionInspection,
} from './acquisitionLaneTaxonomy';
import { bumpAcquisitionLaneEvent } from './operationsTelemetry';

export const ACQUISITION_LANE_TELEMETRY_ENABLED_ENV = 'ACQUISITION_LANE_TELEMETRY_ENABLED';

export function acquisitionLaneTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env[ACQUISITION_LANE_TELEMETRY_ENABLED_ENV] || '').trim().toLowerCase() === 'true';
}

export interface AcquisitionLaneEventInput {
  attribution: AcquisitionAttribution;
  outcome: AcquisitionOutcome;
  summary: Pick<AcquisitionLaneSummary, 'pagesInspected' | 'requestsStarted' | 'renderedCrawls' | 'gateWaitMs' | 'workRemaining' | 'signals'>;
  observedAt?: string;
  capacityEvent?: string;
  detail?: Record<string, unknown>;
}

export interface AcquisitionLaneEventDeps {
  /** Test seam: force the flag without touching process.env. */
  enabled?: () => boolean;
  /** Test seam: inject a query function instead of the live database. */
  query?: (sql: string, values: unknown[]) => Promise<unknown>;
  warn?: (message: string) => void;
}

function isoTimestamp(value: unknown): string {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function eventKey(input: AcquisitionLaneEventInput, attribution: AcquisitionAttribution, observedAt: string): string {
  return createHash('sha256')
    .update([
      attribution.channelId || '',
      attribution.jobId || '',
      attribution.lane,
      input.outcome,
      observedAt,
      String(attribution.slicePass ?? ''),
    ].join('\n'))
    .digest('hex');
}

function boundedDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!detail || typeof detail !== 'object') return {};
  const out: Record<string, unknown> = {};
  let keys = 0;
  for (const [key, value] of Object.entries(detail)) {
    if (keys >= 20) break;
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,48}$/.test(key)) continue;
    if (typeof value === 'string') {
      out[key] = value.slice(0, 160);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    }
    keys++;
  }
  return out;
}

/**
 * Record one inspection/slice outcome. Returns true when the insert was
 * attempted without error and the driver did not report a zero row count; a
 * duplicate event_key conflict is a successful no-op. Never throws.
 */
export async function recordAcquisitionLaneEvent(
  input: AcquisitionLaneEventInput,
  deps: AcquisitionLaneEventDeps = {},
): Promise<boolean> {
  const attribution = sanitizeAcquisitionAttribution(input.attribution);
  if (!attribution || !isAcquisitionOutcome(input.outcome)) return false;

  bumpAcquisitionLaneEvent(attribution.lane, input.outcome, {
    pagesInspected: input.summary.pagesInspected,
    requestsStarted: input.summary.requestsStarted,
    gateWaitMs: input.summary.gateWaitMs,
    workRemaining: input.summary.workRemaining,
  });

  const enabled = deps.enabled ? deps.enabled() : acquisitionLaneTelemetryEnabled();
  if (!enabled) return false;

  const observedAt = isoTimestamp(input.observedAt);
  // Reserve the crawl counter before caller detail consumes the bounded key
  // budget, and never let caller detail override it.
  const callerDetail = input.detail && typeof input.detail === 'object' ? input.detail : {};
  const { renderedCrawls: _callerRenderedCrawls, ...reservedDetail } = callerDetail;
  void _callerRenderedCrawls;
  const detail = boundedDetail({
    renderedCrawls: input.summary.renderedCrawls ?? 0,
    ...reservedDetail,
    observations: input.summary.signals.observations,
    requiredObservations: input.summary.signals.requiredObservations,
    retryOwningObservations: input.summary.signals.retryOwningObservations,
    infrastructureFailures: input.summary.signals.infrastructureFailureObservations,
    conclusiveBlocks: input.summary.signals.conclusiveBlockObservations,
    processedObservations: input.summary.signals.processedObservations,
  });
  const values = [
    eventKey(input, attribution, observedAt),
    attribution.lane,
    input.outcome,
    attribution.jobType || null,
    attribution.jobId || null,
    attribution.channelId || null,
    attribution.slicePass ?? null,
    input.summary.pagesInspected,
    input.summary.requestsStarted,
    input.summary.gateWaitMs ?? null,
    input.summary.workRemaining,
    input.capacityEvent ? String(input.capacityEvent).replace(/\s+/g, ' ').trim().slice(0, 96) || null : null,
    JSON.stringify(detail),
    observedAt,
  ];

  try {
    let result: unknown;
    if (deps.query) {
      result = await deps.query(
        `INSERT INTO acquisition_lane_events(
           event_key,lane,outcome,job_type,job_id,channel_id,slice_pass,
           pages_inspected,requests_started,gate_wait_ms,work_remaining,
           capacity_event,detail,observed_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT(event_key) DO NOTHING`,
        values,
      );
    } else {
      const { getDb } = await import('./dbCore');
      const db = await getDb();
      result = await db.query(
        `INSERT INTO acquisition_lane_events(
           event_key,lane,outcome,job_type,job_id,channel_id,slice_pass,
           pages_inspected,requests_started,gate_wait_ms,work_remaining,
           capacity_event,detail,observed_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT(event_key) DO NOTHING`,
        values,
      );
    }
    const rowCount = (result as { rowCount?: number | null } | null)?.rowCount;
    return typeof rowCount === 'number' ? rowCount > 0 : true;
  } catch (error) {
    const warn = deps.warn || ((message: string) => console.warn(message));
    warn(JSON.stringify({
      event: 'acquisition_lane_event_write_failed',
      lane: attribution.lane,
      outcome: input.outcome,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
      timestamp: new Date().toISOString(),
    }));
    return false;
  }
}

/**
 * Convenience wrapper for the inspection path: classify one inspection and
 * append its lane event. Returns the derived summary even when the DB flag is
 * off so callers can reuse counts without re-running the classifier.
 */
export async function recordAcquisitionInspectionEvent(
  input: {
    attribution?: AcquisitionAttribution;
    channelId: string;
    inspection?: AcquisitionLaneInspection | null;
    retryDirective?: AcquisitionLaneRetryDirective | null;
    observedAt?: string;
  },
  deps: AcquisitionLaneEventDeps = {},
): Promise<AcquisitionLaneSummary | undefined> {
  if (!input.attribution) return undefined;
  const summary = summarizeAcquisitionInspection({
    inspection: input.inspection,
    retryDirective: input.retryDirective,
  });
  await recordAcquisitionLaneEvent({
    attribution: {
      ...input.attribution,
      channelId: input.attribution.channelId || input.channelId,
      workRemaining: summary.workRemaining,
    },
    outcome: summary.outcome,
    summary,
    observedAt: input.observedAt,
    capacityEvent: summary.capacityEvent,
  }, deps);
  return summary;
}
