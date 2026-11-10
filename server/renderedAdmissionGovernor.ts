/**
 * Phase 2 Option C rendered-admission governor.
 *
 * The process-wide browser lease admits one crawl at a time. This governor
 * adds a rolling one-hour admission budget on top of that slot:
 *
 *   * 40 rendered crawls per rolling hour by default;
 *   * up to 48 when the nominal budget is full and other rendered requests are
 *     already queued (the emergency allowance);
 *   * at least 35% DISCOVERY crawls whenever discovery work is queued.
 *
 * The floor is demand-aware: when no DISCOVERY request is waiting, non-discovery
 * work may use the remaining budget (the report will still show the lower
 * discovery share). When discovery work is waiting, non-DISCOVERY admissions
 * are denied while the projected share would fall below the floor.
 *
 * A denied admission is surfaced as the existing
 * `RENDERED_FALLBACK_SATURATED` capacity class, which the retry policy already
 * treats as attempt-free. No new queue, worker, or infrastructure is added.
 *
 * The governor is enabled by default only when NODE_ENV=production (the
 * production image also sets RENDERED_ADMISSION_GOVERNOR_ENABLED=true). Local
 * and CI browser harnesses stay unthrottled; the class is tested directly.
 */

import type { AcquisitionLane } from './acquisitionLaneKeys';

export const RENDERED_ADMISSION_NOMINAL_PER_HOUR_DEFAULT = 40;
export const RENDERED_ADMISSION_EMERGENCY_PER_HOUR_DEFAULT = 48;
export const RENDERED_ADMISSION_DISCOVERY_FLOOR_PCT_DEFAULT = 35;
export const RENDERED_ADMISSION_WINDOW_MS_DEFAULT = 60 * 60 * 1000;

const MAX_PER_HOUR = 1000;
const MIN_WINDOW_MS = 1_000;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RenderedAdmissionConfig {
  enabled: boolean;
  nominalPerHour: number;
  emergencyPerHour: number;
  discoveryFloorPct: number;
  windowMs: number;
}

export type RenderedAdmissionDenialReason = 'RATE_LIMIT' | 'DISCOVERY_FLOOR';

export interface RenderedAdmissionDecision {
  admitted: boolean;
  reason: RenderedAdmissionDenialReason | null;
  lane: AcquisitionLane;
  /** Governor admission id, used to refund a pre-crawl failure. */
  admissionId: number | null;
  admissionsInWindow: number;
  discoveryAdmissionsInWindow: number;
  limit: number;
  emergency: boolean;
  /** When a rate-limited admission can next succeed. */
  retryAtMs: number | null;
}

export interface RenderedAdmissionSnapshot {
  enabled: boolean;
  nominalPerHour: number;
  emergencyPerHour: number;
  discoveryFloorPct: number;
  windowMs: number;
  admissionsInWindow: number;
  discoveryAdmissionsInWindow: number;
  discoverySharePct: number | null;
  nextExpiryAtMs: number | null;
}

export interface RenderedAdmissionGovernorLike {
  admit: (
    lane: AcquisitionLane,
    pendingLanes: ReadonlySet<AcquisitionLane>,
    queuedDemand?: boolean,
  ) => RenderedAdmissionDecision;
  refund: (admissionId: number) => boolean;
  shouldReserveDiscovery: (pendingLanes: ReadonlySet<AcquisitionLane>) => boolean;
  snapshot: () => RenderedAdmissionSnapshot;
}

interface Admission {
  id: number;
  atMs: number;
  lane: AcquisitionLane;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function boundedPct(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(Math.min(100, Math.max(0, parsed)) * 100) / 100;
}

function rawEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function renderedAdmissionGovernorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (rawEnv(env, 'RENDERED_ADMISSION_GOVERNOR_ENABLED') || '').toLowerCase();
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  // Node's test runner sets NODE_TEST_CONTEXT in child processes. Keep the
  // singleton unthrottled even when a developer exports NODE_ENV=production;
  // the gate/governor tests inject an explicitly enabled instance instead.
  if (rawEnv(env, 'NODE_TEST_CONTEXT')) return false;
  return (rawEnv(env, 'NODE_ENV') || '').toLowerCase() === 'production';
}

export function resolveRenderedAdmissionConfig(
  env: NodeJS.ProcessEnv = process.env,
): RenderedAdmissionConfig {
  const nominalPerHour = boundedInt(
    rawEnv(env, 'RENDERED_ADMISSION_NOMINAL_PER_HOUR'),
    RENDERED_ADMISSION_NOMINAL_PER_HOUR_DEFAULT,
    1,
    MAX_PER_HOUR,
  );
  const emergencyPerHour = Math.max(
    nominalPerHour,
    boundedInt(
      rawEnv(env, 'RENDERED_ADMISSION_EMERGENCY_PER_HOUR'),
      RENDERED_ADMISSION_EMERGENCY_PER_HOUR_DEFAULT,
      1,
      MAX_PER_HOUR,
    ),
  );
  return {
    enabled: renderedAdmissionGovernorEnabled(env),
    nominalPerHour,
    emergencyPerHour,
    discoveryFloorPct: boundedPct(
      rawEnv(env, 'RENDERED_ADMISSION_DISCOVERY_FLOOR_PCT'),
      RENDERED_ADMISSION_DISCOVERY_FLOOR_PCT_DEFAULT,
    ),
    windowMs: RENDERED_ADMISSION_WINDOW_MS_DEFAULT,
  };
}

export class RenderedAdmissionGovernor implements RenderedAdmissionGovernorLike {
  private readonly config: RenderedAdmissionConfig;
  private readonly now: () => number;
  private readonly admissions: Admission[] = [];
  private nextAdmissionId = 1;

  constructor(config: Partial<RenderedAdmissionConfig> = {}, now: () => number = Date.now) {
    const base = resolveRenderedAdmissionConfig();
    const nominalPerHour = boundedInt(
      config.nominalPerHour,
      base.nominalPerHour,
      1,
      MAX_PER_HOUR,
    );
    this.config = {
      enabled: config.enabled ?? base.enabled,
      nominalPerHour,
      emergencyPerHour: Math.max(
        nominalPerHour,
        boundedInt(config.emergencyPerHour, base.emergencyPerHour, 1, MAX_PER_HOUR),
      ),
      discoveryFloorPct: boundedPct(config.discoveryFloorPct, base.discoveryFloorPct),
      windowMs: boundedInt(config.windowMs, base.windowMs, MIN_WINDOW_MS, MAX_WINDOW_MS),
    };
    this.now = now;
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.config.windowMs;
    while (this.admissions.length > 0 && this.admissions[0].atMs <= cutoff) {
      this.admissions.shift();
    }
  }

  private discoveryCount(): number {
    return this.admissions.reduce(
      (count, admission) => count + (admission.lane === 'DISCOVERY' ? 1 : 0),
      0,
    );
  }

  private nonDiscoveryCount(): number {
    return this.admissions.length - this.discoveryCount();
  }

  /**
   * Remove an admission that never produced crawl work (for example, the
   * egress proxy or browser launch failed before a request started). Returns
   * true only when the id was still reserved.
   */
  refund(admissionId: number): boolean {
    const index = this.admissions.findIndex(admission => admission.id === admissionId);
    if (index < 0) return false;
    this.admissions.splice(index, 1);
    return true;
  }

  private shouldReserveDiscoveryAt(
    pendingLanes: ReadonlySet<AcquisitionLane>,
  ): boolean {
    if (!this.config.enabled || !pendingLanes.has('DISCOVERY')) return false;
    const total = this.admissions.length;
    const discovery = this.discoveryCount();
    const projectedTotal = total + 1;
    const floorBasisPoints = Math.round(this.config.discoveryFloorPct * 100);
    return discovery * 10000 < floorBasisPoints * projectedTotal;
  }

  shouldReserveDiscovery(pendingLanes: ReadonlySet<AcquisitionLane>): boolean {
    this.prune(this.now());
    return this.shouldReserveDiscoveryAt(pendingLanes);
  }

  admit(
    lane: AcquisitionLane,
    pendingLanes: ReadonlySet<AcquisitionLane>,
    queuedDemand: boolean = false,
  ): RenderedAdmissionDecision {
    const nowMs = this.now();
    this.prune(nowMs);
    const total = this.admissions.length;
    const discovery = this.discoveryCount();
    const admissionId = this.nextAdmissionId++;

    if (!this.config.enabled) {
      return {
        admitted: true,
        reason: null,
        lane,
        admissionId: null,
        admissionsInWindow: total,
        discoveryAdmissionsInWindow: discovery,
        limit: 0,
        emergency: false,
        retryAtMs: null,
      };
    }

    // Emergency engages when the nominal budget is already full and demand is
    // queued: either this request waited behind the active crawl, or another
    // rendered request is already in the queue.
    const emergency = (pendingLanes.size > 0 || queuedDemand)
      && total >= this.config.nominalPerHour;
    const limit = emergency ? this.config.emergencyPerHour : this.config.nominalPerHour;
    const base = {
      lane,
      admissionId: null,
      admissionsInWindow: total,
      discoveryAdmissionsInWindow: discovery,
      limit,
      emergency,
    };

    if (total >= limit) {
      // Report the expiry that actually frees a slot: enough oldest admissions
      // must leave to bring the window below this limit.
      const retryIndex = Math.max(0, total - limit);
      const retryAt = this.admissions[retryIndex];
      return {
        ...base,
        admitted: false,
        reason: 'RATE_LIMIT',
        retryAtMs: retryAt ? retryAt.atMs + this.config.windowMs : nowMs,
      };
    }

    // Strict discovery reserve: non-discovery admissions can never occupy the
    // 35% of the selected limit reserved for DISCOVERY. Unused reserve is not
    // reassigned to non-discovery work.
    if (lane !== 'DISCOVERY') {
      const floorBasisPoints = Math.round(this.config.discoveryFloorPct * 100);
      const discoveryReserve = Math.ceil(limit * floorBasisPoints / 10000);
      const nonDiscoveryLimit = Math.max(0, limit - discoveryReserve);
      if (this.nonDiscoveryCount() >= nonDiscoveryLimit) {
        return {
          ...base,
          admitted: false,
          reason: 'DISCOVERY_FLOOR',
          retryAtMs: null,
        };
      }
    }

    this.admissions.push({ id: admissionId, atMs: nowMs, lane });
    return {
      ...base,
      admitted: true,
      reason: null,
      admissionId,
      admissionsInWindow: total + 1,
      discoveryAdmissionsInWindow: discovery + (lane === 'DISCOVERY' ? 1 : 0),
      retryAtMs: null,
    };
  }

  snapshot(): RenderedAdmissionSnapshot {
    this.prune(this.now());
    const total = this.admissions.length;
    const discovery = this.discoveryCount();
    return {
      enabled: this.config.enabled,
      nominalPerHour: this.config.nominalPerHour,
      emergencyPerHour: this.config.emergencyPerHour,
      discoveryFloorPct: this.config.discoveryFloorPct,
      windowMs: this.config.windowMs,
      admissionsInWindow: total,
      discoveryAdmissionsInWindow: discovery,
      discoverySharePct: total > 0
        ? Math.round((discovery / total) * 10000) / 100
        : null,
      nextExpiryAtMs: this.admissions[0]
        ? this.admissions[0].atMs + this.config.windowMs
        : null,
    };
  }
}

export const renderedAdmissionGovernor = new RenderedAdmissionGovernor();
