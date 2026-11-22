import { getAppSetting, getDb } from './db';

export type DiscoveryArmLane = 'VIDEO' | 'CHANNEL';
export type DiscoveryArmOrdering = 'RELEVANCE' | 'DATE';
export type DiscoveryArmStatus = 'UNPROBED' | 'PROBING' | 'PRODUCTIVE' | 'LOW_NOVELTY' | 'EMPTY';
export type QueryDiscoveryShape = 'RECENCY' | 'ENTITY' | 'LONG_TAIL';

export interface DiscoveryArm {
  lane: DiscoveryArmLane;
  ordering: DiscoveryArmOrdering;
}

export interface QueryDiscoveryArm extends DiscoveryArm {
  queryId: number;
  status: DiscoveryArmStatus;
  probeRuns: number;
  completedRuns: number;
  freshCandidates: number;
  freshConfirmed: number;
  quotaUnits: number;
  lastGlobalSeenShare: number | null;
  lastFreshShare: number | null;
  lastRunAt: string | null;
  cooldownUntil: string | null;
  lastReason: string | null;
}

type Runner = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

const VIDEO: DiscoveryArmLane = 'VIDEO';
const CHANNEL: DiscoveryArmLane = 'CHANNEL';
const RELEVANCE: DiscoveryArmOrdering = 'RELEVANCE';
const DATE: DiscoveryArmOrdering = 'DATE';

const ENTITY_SIGNALS = [
  'topstep', 'ftmo', 'apex', 'myfundedfutures', 'wealthsimple', 'questrade', 'interactive brokers',
  'robinhood', 'tradovate', 'ninjatrader', 'thinkorswim', 'tradingview', 'binance', 'coinbase',
  'oanda', 'ig group', 'saxo', 'xtb', 'plus500', 'etoro', 'ctrader', 'metatrader', 'mt4', 'mt5',
  'schwab', 'fidelity', 'ibkr', 'nordnet', 'avanza', 'swissquote', 'tradezero', 'webull',
];
const RECENCY_SIGNALS = /\b(live|today|tonight|news|earnings|premarket|pre-market|session|now|current|this week|intraday)\b/i;

export function classifyQueryShape(query: string, primaryTerm = '', intent = ''): QueryDiscoveryShape {
  const queryText = query.normalize('NFKC').trim().toLocaleLowerCase('en');
  const primaryText = primaryTerm.normalize('NFKC').trim().toLocaleLowerCase('en');
  const entityText = primaryText && primaryText !== queryText ? `${queryText} ${primaryText}` : queryText;
  if (RECENCY_SIGNALS.test(`${queryText} ${primaryText}`) || /live|news|session|premarket/.test(intent)) return 'RECENCY';
  // Length belongs to the query surface, not to a duplicated primary-term copy.
  const queryTokens = queryText.split(/\s+/u).filter(Boolean);
  // A long-tail intent on a four-token surface is still an educational
  // long-tail query; below four tokens the surface is an entity lookup.
  if (/education|market_analysis|strategy|psychology/.test(intent) && queryTokens.length >= 4) return 'LONG_TAIL';
  if (queryTokens.length <= 4 || ENTITY_SIGNALS.some(signal => entityText.includes(signal))) return 'ENTITY';
  return 'LONG_TAIL';
}

/**
 * Candidate order when an arm is unprobed or newly available. The first arm is
 * the initial probe; later arms are fallbacks, not a mandatory three-step walk.
 */
export function discoveryArmPlan(
  shape: QueryDiscoveryShape,
  query: string,
  options: { quotaFreeRequired?: boolean } = {},
): DiscoveryArm[] {
  const clean = query.normalize('NFKC').toLocaleLowerCase('en');
  const channelViable = clean.split(/\s+/u).filter(Boolean).length <= 5
    || ENTITY_SIGNALS.some(signal => clean.includes(signal));
  if (shape === 'RECENCY') {
    return (options.quotaFreeRequired
      ? [{ lane: VIDEO, ordering: RELEVANCE }]
      : [
          { lane: VIDEO, ordering: DATE },
          { lane: VIDEO, ordering: RELEVANCE },
          { lane: CHANNEL, ordering: RELEVANCE },
        ]);
  }
  if (shape === 'ENTITY') {
    return (options.quotaFreeRequired
      ? [{ lane: VIDEO, ordering: RELEVANCE }]
      : [
          { lane: CHANNEL, ordering: RELEVANCE },
          { lane: VIDEO, ordering: RELEVANCE },
          { lane: VIDEO, ordering: DATE },
        ]);
  }
  if (shape === 'LONG_TAIL') {
    if (options.quotaFreeRequired) return [{ lane: VIDEO, ordering: RELEVANCE }];
    return channelViable
      ? [
          { lane: VIDEO, ordering: RELEVANCE },
          { lane: CHANNEL, ordering: RELEVANCE },
          { lane: VIDEO, ordering: DATE },
        ]
      : [
          { lane: VIDEO, ordering: RELEVANCE },
          { lane: VIDEO, ordering: DATE },
        ];
  }
}

export function armKey(arm: DiscoveryArm): string {
  return `${arm.lane}/${arm.ordering}`;
}

function rowToArm(row: any): QueryDiscoveryArm {
  return {
    queryId: Number(row.query_id),
    lane: String(row.retrieval_lane) as DiscoveryArmLane,
    ordering: String(row.search_ordering) as DiscoveryArmOrdering,
    status: String(row.status) as DiscoveryArmStatus,
    probeRuns: Number(row.probe_runs || 0),
    completedRuns: Number(row.completed_runs || 0),
    freshCandidates: Number(row.fresh_candidates || 0),
    freshConfirmed: Number(row.fresh_confirmed || 0),
    quotaUnits: Number(row.quota_units || 0),
    lastGlobalSeenShare: row.last_global_seen_share == null ? null : Number(row.last_global_seen_share),
    lastFreshShare: row.last_fresh_share == null ? null : Number(row.last_fresh_share),
    lastRunAt: row.last_run_at ? new Date(row.last_run_at).toISOString() : null,
    cooldownUntil: row.cooldown_until ? new Date(row.cooldown_until).toISOString() : null,
    lastReason: row.last_reason == null ? null : String(row.last_reason),
  };
}

export async function getQueryArmStates(queryId: number, runner?: Runner): Promise<QueryDiscoveryArm[]> {
  const db = runner || await getDb();
  const result = await db.query(
    `SELECT query_id,retrieval_lane,search_ordering,status,probe_runs,completed_runs,
            fresh_candidates,fresh_confirmed,quota_units,last_global_seen_share,last_fresh_share,
            last_run_at,cooldown_until,last_reason
       FROM query_discovery_arms WHERE query_id=$1
       ORDER BY updated_at DESC`,
    [queryId],
  );
  return result.rows.map(rowToArm);
}

function isCooling(arm: QueryDiscoveryArm, now: number): boolean {
  return Boolean(arm.cooldownUntil && Date.parse(arm.cooldownUntil) > now);
}

function productiveScore(arm: QueryDiscoveryArm): number {
  const quota = Math.max(1, arm.quotaUnits);
  return (arm.freshConfirmed + arm.freshCandidates * 0.25) / quota;
}

export function chooseArmFromStates(
  queryId: number,
  query: string,
  intent: string,
  states: QueryDiscoveryArm[],
  now = Date.now(),
  primaryTerm = '',
  options: { quotaFreeRequired?: boolean } = {},
): DiscoveryArm | null {
  const byKey = new Map(states.map(state => [armKey(state), state]));
  const shape = classifyQueryShape(query, primaryTerm, intent);
  const planned = discoveryArmPlan(shape, query, options);
  // Productivity cannot override a hard scheduling constraint. Free searches
  // only support VIDEO/RELEVANCE, so a productive CHANNEL or DATE arm must not
  // be selected for them.
  const allowedKeys = new Set(planned.map(armKey));
  const productive = states
    .filter(state => state.status === 'PRODUCTIVE' && !isCooling(state, now))
    .filter(state => !options.quotaFreeRequired || allowedKeys.has(armKey(state)))
    .sort((a, b) => productiveScore(b) - productiveScore(a) || (Date.parse(b.lastRunAt || '') || 0) - (Date.parse(a.lastRunAt || '') || 0));
  if (productive[0]) return { lane: productive[0].lane, ordering: productive[0].ordering };

  for (const arm of planned) {
    const state = byKey.get(armKey(arm));
    if (!state) return arm;
    if (isCooling(state, now)) continue;
    if ((state.status === 'LOW_NOVELTY' || state.status === 'EMPTY')
      && (!state.cooldownUntil || isCooling(state, now))) continue;
    return arm;
  }
  // Every planned arm was probed and skipped. A LOW_NOVELTY arm without a
  // cooldown was explicitly judged too shallow to penalize for two weeks, so
  // give it the bounded second probe instead of cooling the whole query
  // surface. Once the retry is recorded, the arm becomes cooldown-eligible and
  // this pass can no longer select it.
  const retryable = planned
    .map(arm => byKey.get(armKey(arm)))
    .filter((state): state is QueryDiscoveryArm => Boolean(
      state && !isCooling(state, now) && state.status === 'LOW_NOVELTY' && !state.cooldownUntil,
    ))
    .sort((a, b) => (Date.parse(a.lastRunAt || '') || 0) - (Date.parse(b.lastRunAt || '') || 0));
  if (retryable[0]) return { lane: retryable[0].lane, ordering: retryable[0].ordering };
  return null;
}

/** Marks the query as novelty-cooldown when every planned arm is exhausted. */
export async function coolDownQuerySurface(
  queryId: number,
  runner?: Runner,
  until?: Date,
): Promise<void> {
  const db = runner || await getDb();
  if (until) {
    await db.query(
      `UPDATE query_library
          SET novelty_cooldown_until = GREATEST(now(), $2::timestamptz),
              novelty_state = 'LOW_NOVELTY'
        WHERE id=$1`,
      [queryId, until.toISOString()],
    );
    return;
  }
  const days = await getAppSetting('query_novelty_cooldown_days', '14');
  const boundedDays = Math.min(90, Math.max(1, Number.isFinite(Number(days)) ? Math.trunc(Number(days)) : 14));
  await db.query(
    `UPDATE query_library
        SET novelty_cooldown_until = now() + ($2::text || ' days')::interval,
            novelty_state = 'LOW_NOVELTY'
      WHERE id=$1`,
    [queryId, boundedDays],
  );
}

export async function selectQueryArm(
  queryId: number,
  query: string,
  intent: string,
  primaryTerm = '',
  options: { quotaFreeRequired?: boolean } = {},
  runner?: Runner,
): Promise<DiscoveryArm | null> {
  const db = runner || await getDb();
  const states = await getQueryArmStates(queryId, db);
  const arm = chooseArmFromStates(queryId, query, intent, states, Date.now(), primaryTerm, options);
  if (!arm) {
    // A quota-free request only proves that the free arm is unavailable. If
    // any paid arm is still usable, do not put the whole query into cooldown:
    // that would hide CHANNEL/DATE after paid quota returns.
    const paidAlternative = options.quotaFreeRequired
      ? chooseArmFromStates(queryId, query, intent, states, Date.now(), primaryTerm)
      : null;
    if (!paidAlternative) {
      const earliest = states
        .map(state => state.cooldownUntil ? Date.parse(state.cooldownUntil) : NaN)
        .filter(value => Number.isFinite(value) && value > Date.now())
        .sort((a, b) => a - b)[0];
      await coolDownQuerySurface(queryId, db, earliest ? new Date(earliest) : undefined).catch(() => undefined);
    }
  }
  return arm;
}

/**
 * A single shallow low-novelty run is not enough evidence to cool an entire
 * lane for two weeks. Empty remains authoritative immediately; LOW_NOVELTY
 * needs either the configured number of probes or enough completed pages.
 */
export function armCooldownEligible(input: {
  status: DiscoveryArmStatus;
  runs: number;
  pages: number;
  minRuns: number;
  minPages: number;
}): boolean {
  if (input.status === 'EMPTY') return true;
  if (input.status !== 'LOW_NOVELTY') return false;
  return input.runs >= Math.max(1, Math.trunc(input.minRuns) || 1)
    || input.pages >= Math.max(1, Math.trunc(input.minPages) || 1);
}

function statusForRun(input: {
  distinctResults: number;
  freshCandidates: number;
  freshConfirmed: number;
  globalSeenShare: number;
}): DiscoveryArmStatus {
  if (input.distinctResults <= 0) return 'EMPTY';
  const freshShare = input.freshCandidates / Math.max(1, input.distinctResults);
  if (input.freshConfirmed > 0) return 'PRODUCTIVE';
  if (input.globalSeenShare < 0.8 && freshShare >= 0.2) return 'PRODUCTIVE';
  return 'LOW_NOVELTY';
}

/**
 * Persist the outcome of a completed run against its concrete query/lane/order
 * arm. Uses actual channel-ID novelty recorded on the page observations.
 */
export async function recordQueryArmOutcome(runId: string, runner?: Runner, cooldownDaysOverride?: number): Promise<void> {
  const db = runner || await getDb();
  const result = await db.query(
    `WITH run AS (
       SELECT id,query_id,retrieval_lane,search_ordering,distinct_results,quota_used,
              COALESCE(started_at,scheduled_at,now()) AS started_at
         FROM query_runs WHERE id=$1::uuid
     ), run_channels AS (
       SELECT DISTINCT cs.channel_id FROM channel_sightings cs JOIN run ON run.id=cs.query_run_id
     ), classified AS (
       SELECT rc.channel_id,
              (EXISTS (SELECT 1 FROM channels c
                        WHERE c.channel_id=rc.channel_id
                          AND COALESCE(c.created_at,run.started_at) < run.started_at)
               OR EXISTS (SELECT 1 FROM channel_sightings prior
                           WHERE prior.channel_id=rc.channel_id AND prior.query_run_id<>run.id
                             AND prior.observed_at < run.started_at)) AS global_seen,
              EXISTS (SELECT 1 FROM channel_sightings cur
                       WHERE cur.query_run_id=run.id AND cur.channel_id=rc.channel_id
                         AND cur.persisted AND NOT cur.was_known
                         AND cur.funnel_outcome='TRADING_CONFIRMED'
                         AND cur.country_outcome IN ('CONFIRMED','LIKELY')) AS confirmed
         FROM run_channels rc CROSS JOIN run
     )
     SELECT run.query_id,run.retrieval_lane,run.search_ordering,run.distinct_results,run.quota_used,
            (SELECT COUNT(*) FROM classified)::int AS distinct_creators,
            (SELECT COUNT(*) FROM classified WHERE global_seen)::int AS global_seen_creators,
            (SELECT COUNT(*) FROM classified WHERE NOT global_seen)::int AS fresh_candidates,
            (SELECT COUNT(*) FROM classified WHERE NOT global_seen AND confirmed)::int AS fresh_confirmed,
            (SELECT COUNT(*)::int FROM autonomous_query_page_observations p
              WHERE p.query_run_id=run.id AND p.novelty IS NOT NULL) AS pages_with_novelty
       FROM run`,
    [runId],
  );
  const row = result.rows[0];
  if (!row || !row.query_id || !row.retrieval_lane || !row.search_ordering) return;
  const queryId = Number(row.query_id);
  const lane = String(row.retrieval_lane);
  const ordering = String(row.search_ordering);
  const pagesWithNovelty = Number(row.pages_with_novelty || 0);

  // A run without page-novelty evidence cannot update an arm, but it must
  // still be marked checked so reconciliation rotates past it instead of
  // selecting the same unmeasured runs forever.
  if (pagesWithNovelty === 0) {
    await db.query(
      `INSERT INTO query_discovery_arm_runs(
         query_run_id,query_id,retrieval_lane,search_ordering,novelty_observed,recorded_at,last_checked_at
       ) VALUES($1::uuid,$2,$3,$4,false,now(),now())
       ON CONFLICT(query_run_id) DO UPDATE SET last_checked_at=now()`,
      [runId, queryId, lane, ordering],
    );
    return;
  }

  // Overlap is always measured from actual channel IDs, never from a
  // separate result counter that could disagree with the sighting set.
  const distinctResults = Math.max(0, Number(row.distinct_creators || 0));
  const freshCandidates = Math.max(0, Number(row.fresh_candidates || 0));
  const freshConfirmed = Math.max(0, Number(row.fresh_confirmed || 0));
  const globalSeenCreators = Math.max(0, Number(row.global_seen_creators || 0));
  const quotaUnits = Math.max(0, Number(row.quota_used || 0));
  const globalSeenShare = distinctResults > 0 ? globalSeenCreators / distinctResults : 0;

  const previous = (await db.query(
    `SELECT fresh_candidates,fresh_confirmed,quota_units,distinct_creators,global_seen_creators,novelty_observed
       FROM query_discovery_arm_runs WHERE query_run_id=$1::uuid`,
    [runId],
  )).rows[0];
  const contributionChanged = !previous
    || previous.novelty_observed !== true
    || Number(previous.fresh_candidates) !== freshCandidates
    || Number(previous.fresh_confirmed) !== freshConfirmed
    || Number(previous.quota_units) !== quotaUnits
    || Number(previous.distinct_creators) !== distinctResults
    || Number(previous.global_seen_creators) !== globalSeenCreators;

  // One contribution per run. Re-finalization and delayed classification
  // update the same row, so counters cannot double-count. The separate
  // checked timestamp advances on every pass, while recorded_at advances only
  // when the evidence actually changes.
  await db.query(
    `INSERT INTO query_discovery_arm_runs(
       query_run_id,query_id,retrieval_lane,search_ordering,fresh_candidates,fresh_confirmed,
       quota_units,distinct_creators,global_seen_creators,novelty_observed,recorded_at,last_checked_at
     ) VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,true,now(),now())
     ON CONFLICT(query_run_id) DO UPDATE SET
       last_checked_at=now(),
       recorded_at=CASE WHEN $10::boolean THEN now() ELSE query_discovery_arm_runs.recorded_at END,
       fresh_candidates=EXCLUDED.fresh_candidates,
       fresh_confirmed=EXCLUDED.fresh_confirmed,
       quota_units=EXCLUDED.quota_units,
       distinct_creators=EXCLUDED.distinct_creators,
       global_seen_creators=EXCLUDED.global_seen_creators,
       novelty_observed=true`,
    [runId, queryId, lane, ordering, freshCandidates, freshConfirmed, quotaUnits, distinctResults, globalSeenCreators, contributionChanged],
  );

  const aggregate = (await db.query(
    `SELECT COUNT(*)::int AS runs,
            COALESCE(SUM(r.fresh_candidates),0)::int AS fresh_candidates,
            COALESCE(SUM(r.fresh_confirmed),0)::int AS fresh_confirmed,
            COALESCE(SUM(r.quota_units),0)::int AS quota_units,
            COALESCE(SUM(qr.pages_completed),0)::int AS pages,
            MAX(COALESCE(qr.completed_at,qr.started_at,r.recorded_at)) AS last_run_at
       FROM query_discovery_arm_runs r
       LEFT JOIN query_runs qr ON qr.id=r.query_run_id
      WHERE r.query_id=$1 AND r.retrieval_lane=$2 AND r.search_ordering=$3 AND r.novelty_observed=true`,
    [queryId, lane, ordering],
  )).rows[0] || {};
  const latest = (await db.query(
    `SELECT r.fresh_candidates,r.fresh_confirmed,r.distinct_creators,r.global_seen_creators
       FROM query_discovery_arm_runs r
       LEFT JOIN query_runs qr ON qr.id=r.query_run_id
      WHERE r.query_id=$1 AND r.retrieval_lane=$2 AND r.search_ordering=$3 AND r.novelty_observed=true
      ORDER BY COALESCE(qr.completed_at,qr.started_at,r.recorded_at) DESC LIMIT 1`,
    [queryId, lane, ordering],
  )).rows[0] || {};
  const latestDistinct = Math.max(0, Number(latest.distinct_creators || 0));
  const latestFresh = Math.max(0, Number(latest.fresh_candidates || 0));
  const latestConfirmed = Math.max(0, Number(latest.fresh_confirmed || 0));
  const latestSeenShare = latestDistinct > 0 ? Number(latest.global_seen_creators || 0) / latestDistinct : 0;
  const status = statusForRun({
    distinctResults: latestDistinct,
    freshCandidates: latestFresh,
    freshConfirmed: latestConfirmed,
    globalSeenShare: latestSeenShare,
  });
  const days = cooldownDaysOverride ?? Number(await getAppSetting('query_novelty_cooldown_days', '14'));
  const boundedDays = Math.min(90, Math.max(1, Number.isFinite(days) ? Math.trunc(days) : 14));
  const minProbeRuns = Math.max(1, Number(await getAppSetting('query_arm_min_probe_runs', '2')) || 2);
  const minProbePages = Math.max(1, Number(await getAppSetting('query_arm_min_probe_pages', '5')) || 5);
  const cooldown = armCooldownEligible({
    status,
    runs: Number(aggregate.runs || 0),
    pages: Number(aggregate.pages || 0),
    minRuns: minProbeRuns,
    minPages: minProbePages,
  }) ? boundedDays : null;
  await db.query(
    `INSERT INTO query_discovery_arms(
       query_id,retrieval_lane,search_ordering,status,probe_runs,completed_runs,
       fresh_candidates,fresh_confirmed,quota_units,last_global_seen_share,last_fresh_share,
       last_run_at,cooldown_until,last_reason,updated_at
     ) VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,
       CASE WHEN $12::int IS NULL THEN NULL ELSE now()+($12::text || ' days')::interval END,
       $13,now())
     ON CONFLICT(query_id,retrieval_lane,search_ordering) DO UPDATE SET
       status=EXCLUDED.status,
       probe_runs=EXCLUDED.probe_runs,
       completed_runs=EXCLUDED.completed_runs,
       fresh_candidates=EXCLUDED.fresh_candidates,
       fresh_confirmed=EXCLUDED.fresh_confirmed,
       quota_units=EXCLUDED.quota_units,
       last_global_seen_share=EXCLUDED.last_global_seen_share,
       last_fresh_share=EXCLUDED.last_fresh_share,
       last_run_at=EXCLUDED.last_run_at,
       cooldown_until=CASE
         WHEN EXCLUDED.status IN ('LOW_NOVELTY','EMPTY')
           AND query_discovery_arms.cooldown_until IS NOT NULL
           AND query_discovery_arms.cooldown_until > now()
         THEN query_discovery_arms.cooldown_until
         ELSE EXCLUDED.cooldown_until END,
       last_reason=EXCLUDED.last_reason,
       updated_at=now()
     WHERE $14::boolean`,
    [
      queryId, lane, ordering, status, Number(aggregate.runs || 0),
      Number(aggregate.fresh_candidates || 0), Number(aggregate.fresh_confirmed || 0),
      Number(aggregate.quota_units || 0), latestSeenShare, latestDistinct > 0 ? latestFresh / latestDistinct : 0,
      aggregate.last_run_at || new Date().toISOString(), cooldown, status, contributionChanged,
    ],
  );
  if (status === 'PRODUCTIVE') {
    await db.query(
      `UPDATE query_library SET novelty_cooldown_until=NULL, novelty_state='PRODUCTIVE' WHERE id=$1`,
      [queryId],
    ).catch(() => undefined);
  }
}

/** Idempotently refreshes arm contributions for recent runs, including delayed
 * confirmations that resolve after the run completed. */
export async function reconcileQueryArmOutcomes(limit = 100, runner?: Runner): Promise<number> {
  const db = runner || await getDb();
  // Rotate oldest-first and skip contributions refreshed within the last half
  // hour. This keeps every recent run reachable under load instead of letting
  // the newest 200 starve older delayed classifications.
  const runs = await db.query(
    `SELECT qr.id FROM query_runs qr
       LEFT JOIN query_discovery_arm_runs r ON r.query_run_id=qr.id
      WHERE qr.status='COMPLETED' AND qr.query_id IS NOT NULL
        AND qr.retrieval_lane IS NOT NULL AND qr.search_ordering IS NOT NULL
        AND qr.completed_at > now()-interval '2 days'
        AND (r.query_run_id IS NULL OR r.last_checked_at < now()-interval '30 minutes')
      ORDER BY COALESCE(r.last_checked_at,qr.completed_at) ASC LIMIT $1`,
    [Math.max(1, Math.min(500, Math.trunc(limit)))],
  );
  for (const row of runs.rows) {
    await recordQueryArmOutcome(String(row.id), db).catch(() => undefined);
  }
  return runs.rows.length;
}
