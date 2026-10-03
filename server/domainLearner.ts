/**
 * Offline Domain Learner (P-D: route memory + adaptive revisit).
 *
 * Converts logged route outcomes (page_coverage rows) into versioned weight
 * snapshots and revisit intervals. OFFLINE/BATCH ONLY: nothing here runs in
 * the acquisition hot path. Snapshots start DRAFT and become consumable
 * only through explicit human approval; serving code must additionally be
 * admitted by its own flag before reading APPROVED snapshots. Weight
 * snapshots are reproducible (version = content hash) and decisions that
 * consume them record the version used.
 *
 * Safety doctrine: quorum-gated routes (single observations never flip a
 * verdict), exponential time decay (stale data cannot govern), explicit
 * human approval, and a deterministic exploration floor (untested routes
 * can be demoted but never permanently eliminated).
 *
 * Numeric defaults below are conservative initial values pending
 * frozen-fixture derivation in implementation planning (TBD-for-planning);
 * smaller learning influence is always acceptable, larger requires a
 * separately approved experiment.
 */
import { createHash } from 'node:crypto';
import { getRouteStats, recordWeightSnapshot, getApprovedWeights, getAppSetting } from './dbCore';

export const DOMAIN_LEARNER_POLICY_VERSION = 'domain-learner-v1';

/** Conservative initial values (TBD-for-planning with stated methods). */
export const ROUTE_QUORUM_MIN_OBSERVATIONS = 3;
export const ROUTE_HALF_LIFE_MS = 30 * 24 * 60 * 60_000;
export const ROUTE_EXPLORATION_FLOOR_BPS = 500;

export interface RouteObservation {
  siteIdentity: string;
  pageUrl: string;
  evidenceUnits: number;
  terminalState: string;
  observedAt: string;
}

export interface RouteStats {
  siteIdentity: string;
  routePattern: string;
  attempts: number;
  evidenceHits: number;
  evidenceUnits: number;
  lastObservedAt: string | null;
}

export interface DomainWeights {
  version: string;
  siteIdentity: string;
  weights: Record<string, number>;
  trainingWindow: { from: string | null; to: string | null; observations: number };
  metrics: { routes: number; qualifiedRoutes: number; totalEvidenceUnits: number };
  codeVersion: string;
  status: 'DRAFT' | 'APPROVED';
}

/** Normalize a page URL to its route pattern: lowercased host plus path
 * with numeric segments collapsed, query dropped, trailing slash trimmed.
 * Deterministic; same page shape always yields the same pattern. */
export function routePatternFor(pageUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const segments = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map(segment => (/^\d+$/.test(segment) ? '{n}' : segment.toLowerCase()));
  return `${parsed.hostname.toLowerCase()}/${segments.join('/')}`;
}

/** Whether a terminal outcome carries route-yield information worth
 * accumulating. Only COMPLETE inspections qualify: FOUND, INSPECTED_NO_MATCH,
 * and OK. Truncated (PARTIALLY_INSPECTED) pages are excluded even though
 * observed: the unseen suffix is unknown, so counting them as attempts would
 * let incomplete inspections dilute learned yield like clean negatives.
 * Blocked, unreachable, rate-limited, and otherwise incomplete terminals
 * carry NO yield information — recording them as attempts would turn
 * inaccessibility into negative evidence, so they are excluded too. Pure. */
export function shouldAccumulateRouteObservation(terminalState: string): boolean {
  switch (terminalState) {
    case 'FOUND':
    case 'INSPECTED_NO_MATCH':
    case 'OK':
      return true;
    default:
      return false;
  }
}

/** Exponential decay multiplier for an observation age. Pure. */
export function decayWeight(ageMs: number, halfLifeMs: number): number {
  if (!Number.isFinite(ageMs) || !Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return 0;
  const age = Math.max(0, ageMs);
  return Math.pow(0.5, age / halfLifeMs);
}

/** Aggregate coverage rows into per-route statistics. Pure and
 * deterministic; ordering-independent (sorts by pattern). */
export function aggregateRouteStats(observations: RouteObservation[]): RouteStats[] {
  const byRoute = new Map<string, RouteStats & { lastObservedMs: number }>();
  for (const observation of observations) {
    const pattern = routePatternFor(observation.pageUrl);
    if (!pattern) continue;
    const observedMs = Date.parse(observation.observedAt);
    const key = `${observation.siteIdentity}\u0000${pattern}`;
    const current = byRoute.get(key) || {
      siteIdentity: observation.siteIdentity,
      routePattern: pattern,
      attempts: 0,
      evidenceHits: 0,
      evidenceUnits: 0,
      lastObservedAt: null as string | null,
      lastObservedMs: Number.NEGATIVE_INFINITY,
    };
    current.attempts += 1;
    const units = Math.max(0, Math.trunc(observation.evidenceUnits) || 0);
    if (units > 0) {
      current.evidenceHits += 1;
      current.evidenceUnits += units;
    }
    if (Number.isFinite(observedMs) && observedMs > current.lastObservedMs) {
      current.lastObservedMs = observedMs;
      current.lastObservedAt = observation.observedAt;
    }
    byRoute.set(key, current);
  }
  return [...byRoute.values()]
    .sort((a, b) => (a.siteIdentity < b.siteIdentity ? -1 : a.siteIdentity > b.siteIdentity ? 1 : a.routePattern < b.routePattern ? -1 : 1))
    .map(({ lastObservedMs, ...stats }) => stats);
}

/** Compute decayed per-route weights from statistics. Routes below quorum
 * receive zero weight (never negative, never borrowed): a single poisoned
 * or lucky observation cannot flip routing. Deterministic given inputs. */
export function computeDomainWeights(
  siteIdentity: string,
  stats: RouteStats[],
  options: { nowMs?: number; halfLifeMs?: number; quorum?: number } = {},
): Omit<DomainWeights, 'version' | 'status'> {
  const nowMs = options.nowMs ?? Date.now();
  const halfLifeMs = options.halfLifeMs ?? ROUTE_HALF_LIFE_MS;
  const quorum = options.quorum ?? ROUTE_QUORUM_MIN_OBSERVATIONS;
  const weights: Record<string, number> = {};
  let qualifiedRoutes = 0;
  let totalEvidenceUnits = 0;
  let earliest: string | null = null;
  let latest: string | null = null;
  let observations = 0;
  for (const stat of stats) {
    if (stat.siteIdentity !== siteIdentity) continue;
    observations += stat.attempts;
    totalEvidenceUnits += stat.evidenceUnits;
    const lastMs = stat.lastObservedAt ? Date.parse(stat.lastObservedAt) : NaN;
    if (stat.attempts < quorum || !Number.isFinite(lastMs)) {
      weights[stat.routePattern] = 0;
      continue;
    }
    qualifiedRoutes += 1;
    const hitRate = stat.evidenceHits / Math.max(1, stat.attempts);
    weights[stat.routePattern] = hitRate * decayWeight(nowMs - lastMs, halfLifeMs);
    if (earliest === null || stat.lastObservedAt! < earliest) earliest = stat.lastObservedAt;
    if (latest === null || stat.lastObservedAt! > latest) latest = stat.lastObservedAt;
  }
  return {
    siteIdentity,
    weights,
    trainingWindow: { from: earliest, to: latest, observations },
    metrics: { routes: stats.filter(stat => stat.siteIdentity === siteIdentity).length, qualifiedRoutes, totalEvidenceUnits },
    codeVersion: DOMAIN_LEARNER_POLICY_VERSION,
  };
}

/** Seal weights into a versioned snapshot. Version is the content hash, so
 * identical inputs always reproduce the identical version. Starts DRAFT. */
export function buildWeightSnapshot(input: Omit<DomainWeights, 'version' | 'status'>): DomainWeights {
  const body = JSON.stringify({
    siteIdentity: input.siteIdentity,
    weights: input.weights,
    trainingWindow: input.trainingWindow,
    metrics: input.metrics,
    codeVersion: input.codeVersion,
  });
  const version = `dw-${createHash('sha256').update(`${DOMAIN_LEARNER_POLICY_VERSION}:${body}`).digest('hex').slice(0, 16)}`;
  return { ...input, version, status: 'DRAFT' };
}

function routeBucket(seed: string): number {
  const digest = createHash('sha256').update(seed).digest('hex');
  return Number.parseInt(digest.slice(0, 8), 16) % 10000;
}

/** Deterministic exploration-floor route pick: with floor probability (in
 * basis points) the least-tried route is explored; otherwise the max-weight
 * route is exploited (ties broken by pattern order). Untested routes can be
 * demoted by low weights but the floor guarantees they are never
 * permanently eliminated. Pure given the seed. */
export function resolveRoutePick(
  routes: Array<{ pattern: string; weight: number; attempts: number }>,
  floorBps: number,
  seed: string,
): string | null {
  if (!routes.length) return null;
  const floor = Math.min(10000, Math.max(0, Math.trunc(floorBps) || 0));
  const ordered = [...routes].sort((a, b) => (a.pattern < b.pattern ? -1 : 1));
  if (floor > 0 && routeBucket(`${DOMAIN_LEARNER_POLICY_VERSION}:explore:${seed}`) < floor) {
    let least = ordered[0];
    for (const route of ordered) {
      if (route.attempts < least.attempts) least = route;
    }
    return least.pattern;
  }
  let best = ordered[0];
  for (const route of ordered) {
    if (route.weight > best.weight) best = route;
  }
  return best.pattern;
}

/** Adaptive revisit interval: productive, recently-changing routes revisit
 * sooner; quiet routes decay toward the baseline TTL. Always within
 * [minIntervalMs, maxIntervalMs]; monotone in hit rate. Pure. */
export function revisitIntervalMs(input: {
  decayedHitRate: number;
  baseTtlMs: number;
  minIntervalMs: number;
  maxIntervalMs: number;
}): number {
  const rate = Math.min(1, Math.max(0, input.decayedHitRate || 0));
  const base = Math.max(1, input.baseTtlMs);
  const min = Math.max(1, Math.min(input.minIntervalMs, input.maxIntervalMs));
  const max = Math.max(min, input.maxIntervalMs);
  const interval = base / (1 + rate * 3);
  return Math.min(max, Math.max(min, Math.trunc(interval)));
}

export interface DomainLearningDeps {
  getRouteStats?: (siteIdentity: string) => Promise<RouteStats[]>;
  recordWeightSnapshot?: (snapshot: DomainWeights) => Promise<void>;
}

/** Offline batch run: aggregate a site's route counters into a versioned
 * DRAFT snapshot. No scheduling lives here — operators invoke this
 * explicitly (no background learner exists by design). Deterministic given
 * identical counters. Never promotes: approval is a separate human act. */
export async function runDomainLearningBatch(
  siteIdentity: string,
  options: { nowMs?: number; halfLifeMs?: number; quorum?: number; deps?: DomainLearningDeps } = {},
): Promise<{ status: 'DRAFT_RECORDED' | 'NO_DATA'; version: string | null }> {
  if (!siteIdentity) return { status: 'NO_DATA', version: null };
  const getStats = options.deps?.getRouteStats || getRouteStats;
  const recordSnapshot = options.deps?.recordWeightSnapshot || (async (snapshot: DomainWeights) => {
    await recordWeightSnapshot({
      version: snapshot.version,
      siteIdentity: snapshot.siteIdentity,
      weights: snapshot.weights,
      trainingWindow: { from: snapshot.trainingWindow.from, to: snapshot.trainingWindow.to, observations: snapshot.trainingWindow.observations },
      metrics: { routes: snapshot.metrics.routes, qualifiedRoutes: snapshot.metrics.qualifiedRoutes, totalEvidenceUnits: snapshot.metrics.totalEvidenceUnits },
      codeVersion: snapshot.codeVersion,
    });
  });
  const stats = await getStats(siteIdentity);
  if (!stats.length) return { status: 'NO_DATA', version: null };
  const computed = computeDomainWeights(siteIdentity, stats, {
    nowMs: options.nowMs,
    halfLifeMs: options.halfLifeMs,
    quorum: options.quorum,
  });
  const snapshot = buildWeightSnapshot(computed);
  await recordSnapshot(snapshot);
  return { status: 'DRAFT_RECORDED', version: snapshot.version };
}

export const DOMAIN_WEIGHT_EXPERIMENT_SETTING_KEY = 'domain_weight_experiment_enabled';

/**
 * Explicit experimental admission gate for approved domain weights.
 * Default-off (setting absent/false, or read failure, yields false).
 * DRAFT snapshots are never consumable through any path: consumption
 * additionally requires an APPROVED snapshot (see getApprovedWeights).
 * No serving caller exists by design — experiment harnesses call
 * consumeExperimentalWeights explicitly.
 */
export async function isDomainWeightExperimentConsumptionEnabled(
  readSetting: (key: string, fallback: string) => Promise<string> = getAppSetting,
): Promise<boolean> {
  try {
    return (await readSetting(DOMAIN_WEIGHT_EXPERIMENT_SETTING_KEY, 'false')) === 'true';
  } catch {
    return false;
  }
}

export type ExperimentalWeightConsumption =
  | { available: true; version: string; weights: Record<string, number> }
  | { available: false; reason: 'EXPERIMENT_NOT_ENABLED' | 'NO_APPROVED_WEIGHTS' };

/**
 * Consumes the latest APPROVED weight snapshot for a site if and only if
 * the explicit experiment gate is enabled. Returns a machine-readable
 * unavailability reason otherwise. DRAFT snapshots are never returned.
 */
export async function consumeExperimentalWeights(
  siteIdentity: string,
  deps: {
    readSetting?: (key: string, fallback: string) => Promise<string>;
    getApproved?: (siteIdentity: string) => Promise<{ version: string; weights: Record<string, number> } | null>;
  } = {}
): Promise<ExperimentalWeightConsumption> {
  const enabled = await isDomainWeightExperimentConsumptionEnabled(deps.readSetting);
  if (!enabled) return { available: false, reason: 'EXPERIMENT_NOT_ENABLED' };
  const getApproved = deps.getApproved || getApprovedWeights;
  const resolved = await getApproved(siteIdentity);
  if (!resolved) return { available: false, reason: 'NO_APPROVED_WEIGHTS' };
  return { available: true, version: resolved.version, weights: resolved.weights };
}

export interface DomainWeightShadowCandidate {
  url: string;
  score: number;
}

export interface DomainWeightShadowEvaluation {
  siteIdentity: string;
  weightsVersion: string;
  routeCount: number;
  baselineTopUrl: string | null;
  shadowPickUrl: string | null;
  agreement: boolean;
}

/**
 * Shadow evaluation of experimental domain weights against a live crawl
 * order. Observational only: the result never routes, budgets, or stops
 * anything — it records what an approved-weights policy WOULD have picked
 * next to the baseline order for later comparison. Returns null unless the
 * explicit experiment gate admits AND an APPROVED snapshot exists for the
 * site (DRAFT is never consumed). Attempts are unknown in crawl context and
 * recorded as 0 for every route (exploration floor applies uniformly).
 */
export async function evaluateDomainWeightShadow(
  siteIdentity: string,
  candidates: DomainWeightShadowCandidate[],
  deps: {
    readSetting?: (key: string, fallback: string) => Promise<string>;
    getApproved?: (siteIdentity: string) => Promise<{ version: string; weights: Record<string, number> } | null>;
  } = {}
): Promise<DomainWeightShadowEvaluation | null> {
  if (!siteIdentity || !candidates.length) return null;
  const consumption = await consumeExperimentalWeights(siteIdentity, deps);
  if (!consumption.available) return null;
  const routes = candidates.map(candidate => {
    const pattern = routePatternFor(candidate.url) || candidate.url;
    return { pattern, weight: consumption.weights[pattern] ?? 0, attempts: 0, url: candidate.url };
  });
  const pick = resolveRoutePick(
    routes.map(({ pattern, weight, attempts }) => ({ pattern, weight, attempts })),
    ROUTE_EXPLORATION_FLOOR_BPS,
    siteIdentity
  );
  const shadowPickUrl = routes.find(route => route.pattern === pick)?.url ?? null;
  const baselineTopUrl = candidates[0]?.url ?? null;
  return {
    siteIdentity,
    weightsVersion: consumption.version,
    routeCount: routes.length,
    baselineTopUrl,
    shadowPickUrl,
    agreement: shadowPickUrl !== null && shadowPickUrl === baselineTopUrl,
  };
}
