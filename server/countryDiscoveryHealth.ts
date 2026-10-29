import { getDb } from './db';
import { getYouTubeQuotaDay } from './youtubeQuotaDay';
import { parseDiscoveryScopeMode, parseDiscoveryScopeSelection, resolveAutonomousCountries } from './autonomousDiscovery';
import { isContactBearingWikimediaUserAgent, WIKIMEDIA_USER_AGENT_ENV } from './freeQuerySignals';

/**
 * Country Discovery Loop health and observability.
 *
 * The pure evaluator is the deploy gate: a failed migration, missing schema,
 * a disabled YouTube hard cap, stale orphaned pages, or a failing provider
 * canary makes the report unhealthy (the route returns 503). Kill switches are
 * advisory: an operator may intentionally disable one, which degrades the
 * report without declaring the deployment broken. No active provider probe is
 * run here; the provider check uses recent provider_call_events telemetry.
 */

export type CountryDiscoveryHealthStatus = 'PASS' | 'WARN' | 'FAIL';

export interface CountryDiscoveryHealthCheck {
  id: string;
  status: CountryDiscoveryHealthStatus;
  detail: string;
}

export interface CountryDiscoveryHealthReport {
  healthy: boolean;
  status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';
  checkedAt: string;
  checks: CountryDiscoveryHealthCheck[];
}

export interface CountryDiscoveryHealthInput {
  migrationApplied: boolean;
  missingSchema: string[];
  settings: Record<string, string | undefined>;
  orphanPendingPages: number;
  oldestOrphanAgeMinutes?: number;
  /** false = failing canary/telemetry; null/undefined = no recent telemetry. */
  providerCanaryOk?: boolean | null;
  providerCanaryDetail?: string;
  aiActualCostMicrounits?: number;
  aiBudgetMicrounits?: number;
  aiBudgetSkips?: number;
  aiCalls?: number;
  activeCountriesWithoutPage?: number;
  /** Quota deferrals are the observable outcome of reservation denials. */
  quotaDeferralsRecent?: number;
  quotaDeferralsPrior?: number;
  /** null means the window has no observations and must not be evaluated. */
  duplicateRatioWindows?: { recent: number | null; prior: number | null };
  wrongCountryPrecisionWindows?: { recent: number | null; prior: number | null };
  providerErrorRate?: number | null;
  providerTimeoutRate?: number | null;
  providerRateLimitRate?: number | null;
  wikimediaUserAgentConfigured?: boolean;
}

export const CDL_REQUIRED_SCHEMA: ReadonlyArray<readonly [table: string, column: string]> = Object.freeze([
  ['terminology_observations', 'promotion_eligible'],
  ['autonomous_query_page_observations', 'elapsed_ms'],
  ['autonomous_query_page_observations', 'marginal_confirmed_creators'],
  ['autonomous_query_page_observations', 'novel_candidate_terms'],
  ['autonomous_query_page_observations', 'cross_page_repeat_creators'],
  ['autonomous_query_page_observations', 'cumulative_unique_creators'],
  ['autonomous_query_page_observations', 'continuation_decision_v2'],
  ['autonomous_query_page_observations', 'resume_mode'],
  ['autonomous_query_page_observations', 'provider_page_cost_usd'],
  ['autonomous_query_page_observations', 'relevance'],
  ['autonomous_query_page_observations', 'marginal_utility_v2'],
  ['query_runs', 'pages_completed'],
  ['query_runs', 'next_page_token'],
  ['query_runs', 'continuation_status'],
  ['query_runs', 'deferred_until'],
  ['query_runs', 'effective_max_pages'],
  ['query_runs', 'effective_binding_bound'],
  ['query_runs', 'run_quota_budget_units'],
  ['query_runs', 'run_quota_consumed_units'],
  ['query_runs', 'requested_page_depth'],
  ['query_runs', 'resume_mode'],
  ['query_runs', 'continued_from_run_id'],
  ['native_vocabulary_ai_runs', 'request_id'],
  ['free_query_signals', 'normalized_surface'],
  ['query_demand_signals', 'demand_score'],
]);

const CORE_ACTIVE_SETTINGS = [
  'country_discovery_loop_enabled',
  'autonomous_pagination_enabled',
  'autonomous_pagination_v2_enabled',
  'native_evidence_promotion_v2_enabled',
  'native_vocabulary_extraction_enabled',
  'free_query_signals_enabled',
] as const;

const CDL_SETTING_KEYS = [
  ...CORE_ACTIVE_SETTINGS,
  'wikimedia_pageviews_enabled',
  'query_demand_signals_enabled',
  'youtube_key_daily_cap_enforced',
  'native_vocabulary_ai_daily_cost_microunits',
  'query_intelligence_discovery_scope',
  'query_intelligence_selected_countries',
] as const;

const ORPHAN_AGE_MINUTES = 15;

export function evaluateCountryDiscoveryHealth(
  input: CountryDiscoveryHealthInput,
  now = new Date(),
): CountryDiscoveryHealthReport {
  const checks: CountryDiscoveryHealthCheck[] = [];
  const add = (id: string, status: CountryDiscoveryHealthStatus, detail: string) => {
    checks.push({ id, status, detail });
  };

  add(
    'migration_161',
    input.migrationApplied ? 'PASS' : 'FAIL',
    input.migrationApplied
      ? 'Migration 161 is recorded in schema_migrations.'
      : 'Migration 161 is missing from schema_migrations.',
  );

  add(
    'required_schema',
    input.missingSchema.length === 0 ? 'PASS' : 'FAIL',
    input.missingSchema.length === 0
      ? `All ${CDL_REQUIRED_SCHEMA.length} required columns are present.`
      : `Missing required schema: ${input.missingSchema.join(', ')}.`,
  );

  const hardCap = input.settings.youtube_key_daily_cap_enforced;
  add(
    'youtube_hard_cap',
    hardCap === 'true' ? 'PASS' : 'FAIL',
    hardCap === 'true'
      ? 'youtube_key_daily_cap_enforced=true; the global hard cap is authoritative.'
      : `youtube_key_daily_cap_enforced is ${hardCap === undefined ? 'missing' : `'${hardCap}'`}; the hard cap must remain true.`,
  );

  // The scheduler and queue worker parse both scope values strictly and fail
  // closed. Health must use the same parsers: silently collapsing an invalid
  // mode to GLOBAL would return 200 while scheduling is actually stopped.
  let scopeError: string | null = null;
  try {
    parseDiscoveryScopeMode(input.settings.query_intelligence_discovery_scope ?? 'GLOBAL');
  } catch {
    scopeError = `query_intelligence_discovery_scope is '${input.settings.query_intelligence_discovery_scope}' (expected GLOBAL or SELECTED_COUNTRIES).`;
  }
  if (!scopeError) {
    try {
      parseDiscoveryScopeSelection(input.settings.query_intelligence_selected_countries ?? '[]');
    } catch {
      scopeError = 'query_intelligence_selected_countries is malformed JSON or not an array of country names.';
    }
  }
  add(
    'discovery_scope',
    scopeError ? 'FAIL' : 'PASS',
    scopeError
      || `Discovery scope ${input.settings.query_intelligence_discovery_scope || 'GLOBAL'} is valid.`,
  );

  add(
    'orphan_pending_pages',
    input.orphanPendingPages === 0 ? 'PASS' : 'FAIL',
    input.orphanPendingPages === 0
      ? 'No pending continuation is older than 15 minutes.'
      : `${input.orphanPendingPages} pending continuation(s) older than 15 minutes (oldest ${Number(input.oldestOrphanAgeMinutes || 0).toFixed(1)}m).`,
  );

  const canary = input.providerCanaryOk;
  add(
    'provider_canary',
    canary === false ? 'FAIL' : canary === true ? 'PASS' : 'WARN',
    input.providerCanaryDetail
      || (canary === false
        ? 'Recent provider telemetry is failing.'
        : canary === true
          ? 'Recent provider telemetry is healthy.'
          : 'No recent provider telemetry; no active probe is run by this health check.'),
  );

  if (
    input.providerErrorRate != null
    || input.providerTimeoutRate != null
    || input.providerRateLimitRate != null
  ) {
    const errorRate = Math.max(0, Number(input.providerErrorRate || 0));
    const timeoutRate = Math.max(0, Number(input.providerTimeoutRate || 0));
    const rateLimitRate = Math.max(0, Number(input.providerRateLimitRate || 0));
    const worst = Math.max(errorRate, timeoutRate, rateLimitRate);
    add(
      'provider_spike',
      worst >= 0.25 ? 'FAIL' : worst >= 0.1 ? 'WARN' : 'PASS',
      `Provider error/timeout/rate-limit rates: ${(errorRate * 100).toFixed(1)}% / ${(timeoutRate * 100).toFixed(1)}% / ${(rateLimitRate * 100).toFixed(1)}%.`,
    );
  }

  if (input.quotaDeferralsRecent !== undefined || input.quotaDeferralsPrior !== undefined) {
    const recent = Math.max(0, Number(input.quotaDeferralsRecent || 0));
    const prior = Math.max(0, Number(input.quotaDeferralsPrior || 0));
    const elevated = recent >= 5 && recent > prior * 2;
    add(
      'quota_reservation_failures',
      elevated ? 'WARN' : 'PASS',
      elevated
        ? `${recent} quota deferral(s) in the last hour versus ${prior} in the prior hour; reservation failures are above baseline.`
        : `Quota deferrals ${recent} (last hour) vs ${prior} (prior hour); no above-baseline spike.`,
    );
  }

  const measured = (value: number | null | undefined): number | null =>
    value === null || value === undefined ? null : Math.max(0, Number(value));
  const windowLabel = (value: number | null): string =>
    value === null ? 'not measured' : `${(value * 100).toFixed(1)}%`;

  const duplicate = input.duplicateRatioWindows;
  if (duplicate) {
    const recent = measured(duplicate.recent);
    const prior = measured(duplicate.prior);
    // An empty window is unknown, not a healthy zero: evaluate only windows
    // that actually contain observations. A two-window FAIL requires both.
    if (recent !== null || prior !== null) {
      const both = recent !== null && prior !== null && recent >= 0.9 && prior >= 0.9;
      const either = (recent !== null && recent >= 0.9) || (prior !== null && prior >= 0.9);
      add(
        'duplicate_ratio_two_windows',
        both ? 'FAIL' : either ? 'WARN' : 'PASS',
        `Duplicate ratio recent ${windowLabel(recent)} / prior ${windowLabel(prior)} (safety cap 90% for two consecutive windows).`,
      );
    }
  }

  const wrongCountry = input.wrongCountryPrecisionWindows;
  if (wrongCountry) {
    const recent = measured(wrongCountry.recent);
    const prior = measured(wrongCountry.prior);
    if (recent !== null || prior !== null) {
      const both = recent !== null && prior !== null && recent < 0.5 && prior < 0.5;
      const either = (recent !== null && recent < 0.5) || (prior !== null && prior < 0.5);
      add(
        'wrong_country_two_windows',
        both ? 'FAIL' : either ? 'WARN' : 'PASS',
        `Country precision recent ${windowLabel(recent)} / prior ${windowLabel(prior)} (safety floor 50% for two consecutive windows).`,
      );
    }
  }

  if (input.aiBudgetSkips !== undefined) {
    const skips = Math.max(0, Number(input.aiBudgetSkips || 0));
    const calls = Math.max(0, Number(input.aiCalls || 0));
    const ratio = calls > 0 ? skips / calls : 0;
    const spike = skips >= 10 || ratio >= 0.5;
    add(
      'ai_budget_skips',
      spike ? 'WARN' : 'PASS',
      `${skips} AI budget skip(s) across ${calls} logical call(s) (${(ratio * 100).toFixed(1)}%).`,
    );
  }

  if (input.wikimediaUserAgentConfigured !== undefined) {
    const freeSignalsOn = input.settings.free_query_signals_enabled === 'true';
    add(
      'wikimedia_user_agent',
      !freeSignalsOn || input.wikimediaUserAgentConfigured ? 'PASS' : 'WARN',
      !freeSignalsOn
        ? 'Free-signal enrichment is disabled; the Wikimedia User-Agent prerequisite is dormant.'
        : input.wikimediaUserAgentConfigured
          ? `${WIKIMEDIA_USER_AGENT_ENV} is configured for Wikimedia API etiquette.`
          : `${WIKIMEDIA_USER_AGENT_ENV} is not set. Free-signal legal/ToS review requires a real contact URL or email; set ${WIKIMEDIA_USER_AGENT_ENV} or descope free signals from this release.`,
    );
  }

  const paid = input.settings.query_demand_signals_enabled;
  add(
    'paid_demand_off',
    paid === 'true' ? 'FAIL' : paid === 'false' ? 'PASS' : 'WARN',
    paid === 'true'
      ? 'query_demand_signals_enabled=true without separate paid-provider approval.'
      : paid === 'false'
        ? 'Paid demand adapter is disabled.'
        : 'query_demand_signals_enabled is not set; paid demand is not active.',
  );

  const disabled = CORE_ACTIVE_SETTINGS.filter(key => input.settings[key] !== 'true');
  add(
    'core_kill_switches',
    disabled.length === 0 ? 'PASS' : 'WARN',
    disabled.length === 0
      ? 'All approved CDL core paths are enabled.'
      : `Operator kill switch disabled: ${disabled.join(', ')}. Data remains intact and only that path is off.`,
  );

  const pageviews = input.settings.wikimedia_pageviews_enabled;
  add(
    'wikimedia_pageviews_off',
    pageviews === 'true' ? 'WARN' : 'PASS',
    pageviews === 'true'
      ? 'wikimedia_pageviews_enabled=true is optional and outside the approved core path.'
      : 'Optional Wikimedia pageviews prior is off.',
  );

  const actual = Math.max(0, Number(input.aiActualCostMicrounits || 0));
  const budget = Math.max(1, Number(input.aiBudgetMicrounits || 5_000_000));
  const ratio = actual / budget;
  add(
    'ai_daily_cost',
    ratio > 1 ? 'FAIL' : ratio >= 0.9 ? 'WARN' : 'PASS',
    `AI extraction actual cost ${actual} / ${budget} microunits (${(ratio * 100).toFixed(1)}%).`,
  );

  if (input.activeCountriesWithoutPage !== undefined) {
    add(
      'active_country_coverage',
      input.activeCountriesWithoutPage === 0 ? 'PASS' : 'WARN',
      input.activeCountriesWithoutPage === 0
        ? 'Every configured active country has a page in the last 24 hours.'
        : `${input.activeCountriesWithoutPage} configured active country/countries have no page in the last 24 hours; check the sweep.`,
    );
  }

  const status = checks.some(check => check.status === 'FAIL')
    ? 'UNHEALTHY'
    : checks.some(check => check.status === 'WARN')
      ? 'DEGRADED'
      : 'HEALTHY';
  return {
    healthy: status !== 'UNHEALTHY',
    status,
    checkedAt: now.toISOString(),
    checks,
  };
}

interface HealthRunner {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export async function gatherCountryDiscoveryHealth(clientOverride?: HealthRunner): Promise<CountryDiscoveryHealthReport> {
  const runner = clientOverride || (await getDb()) as unknown as HealthRunner;
  const settingsRows = await runner.query(
    `SELECT setting_key, setting_value FROM app_settings WHERE setting_key = ANY($1)`,
    [CDL_SETTING_KEYS],
  );
  const settings: Record<string, string | undefined> = {};
  for (const row of settingsRows.rows || []) {
    settings[String(row.setting_key)] = row.setting_value === null || row.setting_value === undefined
      ? undefined
      : String(row.setting_value);
  }

  // Schema evidence is a prerequisite, not a peer: dependent queries reference
  // migration-161 tables, so running them concurrently would reject the whole
  // report before the evaluator can say which schema is missing.
  const migration = await runner.query(`SELECT 1 FROM schema_migrations WHERE version=161`);
  const schema = await runner.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name = ANY($1) AND column_name = ANY($2)`,
    [
      [...new Set(CDL_REQUIRED_SCHEMA.map(([table]) => table))],
      [...new Set(CDL_REQUIRED_SCHEMA.map(([, column]) => column))],
    ],
  );
  const present = new Set(
    (schema.rows || []).map(row => `${String(row.table_name)}.${String(row.column_name)}`),
  );
  const missingSchema = CDL_REQUIRED_SCHEMA
    .filter(([table, column]) => !present.has(`${table}.${column}`))
    .map(([table, column]) => `${table}.${column}`);
  const migrationApplied = (migration.rows || []).length > 0;
  const schemaReady = migrationApplied && missingSchema.length === 0;

  const empty = { rows: [] as Array<Record<string, unknown>> };
  let orphans = empty;
  let provider = empty;
  let ai = empty;
  let safety = empty;
  let quotaDeferrals = empty;
  let vocab = empty;
  let excluded = empty;
  let recentCountries = empty;
  if (schemaReady) {
    [orphans, provider, ai, safety, quotaDeferrals, vocab, excluded, recentCountries] = await Promise.all([
      runner.query(
        `SELECT COUNT(*)::int AS count,
                COALESCE(MAX(EXTRACT(EPOCH FROM (now()-COALESCE(last_page_at,started_at,scheduled_at)))/60),0)::float AS oldest_minutes
         FROM query_runs
         WHERE continuation_status IN ('RUNNING','DEFERRED_QUOTA','DEFERRED_TIME')
           AND status NOT IN ('COMPLETED','FAILED')
           AND (deferred_until IS NULL OR deferred_until <= now())
           -- A live page job is queue backlog, not a missing page. The
           -- reconciler uses the same exclusion; without it a legitimately
           -- queued continuation older than 15 minutes fails the health route.
           AND NOT EXISTS (
             SELECT 1 FROM jobs j
             WHERE j.status IN ('PENDING','PROCESSING')
               AND (
                 j.idempotency_key = 'search-run:'||query_runs.id
                 OR j.idempotency_key = 'search-run:'||query_runs.id||':page:1'
                 OR j.idempotency_key = 'search-run:'||query_runs.id||':page:'||GREATEST(pages_completed+1,1)
               )
           )
           AND COALESCE(last_page_at,started_at,scheduled_at) < now() - interval '${ORPHAN_AGE_MINUTES} minutes'`,
      ),
      runner.query(
        `SELECT COUNT(*)::int AS calls,
                COUNT(*) FILTER (WHERE status='SUCCESS')::int AS successes,
                COUNT(*) FILTER (WHERE status='TIMEOUT')::int AS timeouts,
                COUNT(*) FILTER (WHERE status='RATE_LIMITED')::int AS rate_limited,
                COUNT(*) FILTER (WHERE status NOT IN ('SUCCESS','TIMEOUT','RATE_LIMITED','CANCELLED'))::int AS errors
         FROM provider_call_events
         WHERE occurred_at >= now() - interval '1 hour'
           -- The canary is about discovery search providers only. Unrelated
           -- Gemini/Groq enrichment failures must not make search look unhealthy.
           AND (
             (provider IN ('youtube','youtube-innertube') AND operation='search')
             OR (provider='brave-search' AND operation='search')
           )`,
      ),
      runner.query(
        `SELECT COUNT(*)::int AS calls,
                COUNT(*) FILTER (WHERE status='BUDGET_SKIPPED')::int AS budget_skips,
                COALESCE(SUM(actual_cost_microunits),0)::bigint AS actual_cost
         FROM native_vocabulary_ai_runs WHERE budget_day=$1`,
        [getYouTubeQuotaDay()],
      ),
      runner.query(
        `SELECT
           (AVG(duplicate_ratio) FILTER (WHERE created_at >= now()-interval '24 hours'))::float AS duplicate_recent,
           (AVG(duplicate_ratio) FILTER (WHERE created_at >= now()-interval '48 hours' AND created_at < now()-interval '24 hours'))::float AS duplicate_prior,
           (AVG(country_precision) FILTER (WHERE created_at >= now()-interval '24 hours'))::float AS precision_recent,
           (AVG(country_precision) FILTER (WHERE created_at >= now()-interval '48 hours' AND created_at < now()-interval '24 hours'))::float AS precision_prior
         FROM autonomous_query_page_observations`,
      ),
      runner.query(
        `SELECT
           COUNT(*) FILTER (WHERE COALESCE(last_page_at,started_at,scheduled_at) >= now()-interval '1 hour')::int AS recent,
           COUNT(*) FILTER (WHERE COALESCE(last_page_at,started_at,scheduled_at) >= now()-interval '2 hours'
                              AND COALESCE(last_page_at,started_at,scheduled_at) < now()-interval '1 hour')::int AS prior
         FROM query_runs WHERE continuation_status='DEFERRED_QUOTA'`,
      ),
      runner.query(`SELECT country FROM country_vocabularies`),
      runner.query(`SELECT country_name FROM excluded_countries`),
      runner.query(
        `SELECT DISTINCT qr.country
         FROM query_runs qr
         JOIN autonomous_query_page_observations p ON p.query_run_id=qr.id
         WHERE p.created_at >= now()-interval '24 hours'`,
      ),
    ]);
  }

  const providerRow = (provider.rows || [])[0] || {};
  const providerCalls = Number(providerRow.calls || 0);
  const providerSuccessRate = providerCalls > 0 ? Number(providerRow.successes || 0) / providerCalls : null;
  const providerCanaryOk = providerSuccessRate === null ? null : providerSuccessRate >= 0.5;
  const providerErrorRate = providerCalls > 0 ? Number(providerRow.errors || 0) / providerCalls : null;
  const providerTimeoutRate = providerCalls > 0 ? Number(providerRow.timeouts || 0) / providerCalls : null;
  const providerRateLimitRate = providerCalls > 0 ? Number(providerRow.rate_limited || 0) / providerCalls : null;

  const aiBudget = Number(settings.native_vocabulary_ai_daily_cost_microunits || 5_000_000);
  const aiRow = (ai.rows || [])[0] || {};
  const safetyRow = (safety.rows || [])[0] || {};
  const quotaRow = (quotaDeferrals.rows || [])[0] || {};

  // Invalid persisted scope values are surfaced as a FAIL check by the pure
  // evaluator. Keep the country list computation bounded here (GLOBAL/[]) so
  // the health endpoint still returns its diagnostic report rather than a 500.
  let scope: 'GLOBAL' | 'SELECTED_COUNTRIES' = 'GLOBAL';
  let selectedCountries: string[] = [];
  try {
    scope = parseDiscoveryScopeMode(settings.query_intelligence_discovery_scope ?? 'GLOBAL');
    selectedCountries = parseDiscoveryScopeSelection(settings.query_intelligence_selected_countries ?? '[]');
  } catch {
    scope = 'GLOBAL';
    selectedCountries = [];
  }
  const activeCountries = resolveAutonomousCountries(
    (vocab.rows || []).map(row => String(row.country)),
    (excluded.rows || []).map(row => String(row.country_name)),
    selectedCountries,
    scope,
  );
  const recentCountrySet = new Set(
    (recentCountries.rows || []).map(row => String(row.country).toLowerCase()),
  );
  const activeCountriesWithoutPage = activeCountries
    .filter(country => !recentCountrySet.has(country.toLowerCase()))
    .length;

  return evaluateCountryDiscoveryHealth({
    migrationApplied,
    missingSchema,
    settings,
    orphanPendingPages: Number(((orphans.rows || [])[0] || {}).count || 0),
    oldestOrphanAgeMinutes: Number(((orphans.rows || [])[0] || {}).oldest_minutes || 0),
    providerCanaryOk,
    providerCanaryDetail: providerCalls === 0
      ? 'No provider calls in the last hour; no active probe is run by this health check.'
      : `Recent provider telemetry: ${Number(providerRow.successes || 0)}/${providerCalls} successful (${Number(providerRow.timeouts || 0)} timeout, ${Number(providerRow.errors || 0)} error).`,
    providerErrorRate,
    providerTimeoutRate,
    providerRateLimitRate,
    aiActualCostMicrounits: Number(aiRow.actual_cost || 0),
    aiBudgetMicrounits: aiBudget,
    aiBudgetSkips: Number(aiRow.budget_skips || 0),
    aiCalls: Number(aiRow.calls || 0),
    activeCountriesWithoutPage,
    quotaDeferralsRecent: Number(quotaRow.recent || 0),
    quotaDeferralsPrior: Number(quotaRow.prior || 0),
    duplicateRatioWindows: {
      recent: safetyRow.duplicate_recent == null ? null : Number(safetyRow.duplicate_recent),
      prior: safetyRow.duplicate_prior == null ? null : Number(safetyRow.duplicate_prior),
    },
    wrongCountryPrecisionWindows: {
      recent: safetyRow.precision_recent == null ? null : Number(safetyRow.precision_recent),
      prior: safetyRow.precision_prior == null ? null : Number(safetyRow.precision_prior),
    },
    wikimediaUserAgentConfigured: isContactBearingWikimediaUserAgent(process.env[WIKIMEDIA_USER_AGENT_ENV]),
  });
}

export interface CountryDiscoveryMetrics {
  generatedAt: string;
  page: {
    pages: number;
    pagesLast24h: number;
    rawResults: number;
    distinctCreators: number;
    newCreators: number;
    confirmedCreators: number;
    qualityCreators: number;
    crossPageRepeats: number;
    averageDuplicateRatio: number;
    averageCountryPrecision: number;
    averageTradingPrecision: number;
    averageRelevance: number;
    quotaUnits: number;
    providerCostUsd: number;
    averageElapsedMs: number;
    averageRetrievalMs: number;
    averageProcessingMs: number;
    averageMarginalUtility: number;
    missingDecisions: number;
    resumedPages: number;
    deferredPages: number;
    decisions: Array<{ reason: string; count: number }>;
  };
  run: {
    runs: number;
    running: number;
    deferredQuota: number;
    deferredTime: number;
    complete: number;
    failed: number;
    pagesCompleted: number;
    averageEffectiveMaxPages: number;
    runQuotaBudgetUnits: number;
    runQuotaConsumedUnits: number;
    cumulativeUniqueCreators: number;
    confirmedCreators: number;
    qualityCreators: number;
    resumeCount: number;
    resumeRewalks: number;
    continuationSegments: number;
    elapsedSeconds: number;
    stopReasons: Array<{ reason: string; count: number }>;
  };
  countries: Array<{
    country: string;
    queriesGenerated: number;
    queriesExecuted: number;
    runs: number;
    pages: number;
    quotaUnits: number;
    newCreators: number;
    confirmedCreators: number;
    qualityCreators: number;
    wrongCountryShare: number;
    duplicateRate: number;
    zeroYieldStreak: number;
    pendingContinuations: number;
    oldestPendingAgeMinutes: number;
  }>;
  sources: Array<{
    source: string;
    runs: number;
    pages: number;
    newCreators: number;
    confirmedCreators: number;
    qualityCreators: number;
    acceptanceRate: number;
    costPerQualityCreator: number;
  }>;
  providers: Array<{
    provider: string;
    calls: number;
    successes: number;
    errors: number;
    rateLimited: number;
    timeouts: number;
    successRate: number;
    errorRate: number;
    rateLimitRate: number;
    timeoutRate: number;
    pages: number;
    quotaUnits: number;
    costUsd: number;
    providerCostUsd: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
  }>;
  ai: {
    calls: number;
    attempts: number;
    budgetSkips: number;
    successes: number;
    failures: number;
    actualCostMicrounits: number;
    countries: Array<{ country: string; calls: number; actualCostMicrounits: number }>;
  };
  lifecycle: {
    observations: number;
    promotionEligible: number;
    promotionEligibleShare: number;
    stages: Record<string, number>;
    stageConversion: Record<string, number>;
    promotions: number;
    demotions: number;
    wrongCountryShare: number;
    reviewShare: number;
  };
}

const METRICS_CACHE_TTL_MS = 30_000;
let metricsCache: { at: number; metrics: CountryDiscoveryMetrics } | null = null;
let metricsInFlight: Promise<CountryDiscoveryMetrics> | null = null;

/** Tests and diagnostics can clear the short-lived default-path cache. */
export function resetCountryDiscoveryMetricsCacheForTests(): void {
  metricsCache = null;
  metricsInFlight = null;
}

/**
 * Metrics are read by dashboards and health checks; a short TTL coalesces
 * concurrent readers without hiding a material change for more than 30s.
 * Explicit runners always read live data so tests stay deterministic.
 */
export async function gatherCountryDiscoveryMetrics(clientOverride?: HealthRunner): Promise<CountryDiscoveryMetrics> {
  if (clientOverride) return gatherCountryDiscoveryMetricsUncached(clientOverride);
  if (metricsCache && Date.now() - metricsCache.at < METRICS_CACHE_TTL_MS) {
    return metricsCache.metrics;
  }
  if (metricsInFlight) return metricsInFlight;
  metricsInFlight = gatherCountryDiscoveryMetricsUncached()
    .then(metrics => {
      metricsCache = { at: Date.now(), metrics };
      return metrics;
    })
    .finally(() => {
      metricsInFlight = null;
    });
  return metricsInFlight;
}

async function gatherCountryDiscoveryMetricsUncached(clientOverride?: HealthRunner): Promise<CountryDiscoveryMetrics> {
  const runner = clientOverride || (await getDb()) as unknown as HealthRunner;
  const [
    pageRun, pageDecisions, runStopReasons, countries, countryStreaks,
    sources, providers, ai, aiCountries, lifecycle, lifecycleStages,
    lifecycleEvents, lifecyclePerformance,
  ] = await Promise.all([
    runner.query(
      `SELECT
         (SELECT COUNT(*)::int FROM autonomous_query_page_observations) AS pages,
         (SELECT COUNT(*)::int FROM autonomous_query_page_observations WHERE created_at >= now() - interval '24 hours') AS pages_last_24h,
         (SELECT COALESCE(SUM(raw_result_count),0)::int FROM autonomous_query_page_observations) AS raw_results,
         (SELECT COALESCE(SUM(distinct_creator_count),0)::int FROM autonomous_query_page_observations) AS distinct_creators,
         (SELECT COALESCE(SUM(marginal_new_creators),0)::int FROM autonomous_query_page_observations) AS new_creators,
         (SELECT COALESCE(SUM(marginal_confirmed_creators),0)::int FROM autonomous_query_page_observations) AS confirmed_creators,
         (SELECT COALESCE(SUM(marginal_quality_creators),0)::int FROM autonomous_query_page_observations) AS quality_creators,
         (SELECT COALESCE(SUM(cross_page_repeat_creators),0)::int FROM autonomous_query_page_observations) AS cross_page_repeats,
         (SELECT COALESCE(AVG(duplicate_ratio),0)::float FROM autonomous_query_page_observations) AS average_duplicate_ratio,
         (SELECT COALESCE(AVG(country_precision),0)::float FROM autonomous_query_page_observations) AS average_country_precision,
         (SELECT COALESCE(AVG(CASE WHEN jsonb_typeof(relevance->'tradingPrecision')='number' THEN (relevance->>'tradingPrecision')::float END),0)::float FROM autonomous_query_page_observations) AS average_trading_precision,
         (SELECT COALESCE(AVG(CASE WHEN jsonb_typeof(relevance->'qualityShare')='number' THEN (relevance->>'qualityShare')::float END),0)::float FROM autonomous_query_page_observations) AS average_relevance,
         (SELECT COALESCE(SUM(quota_units),0)::int FROM autonomous_query_page_observations) AS quota_units,
         (SELECT COALESCE(SUM(provider_page_cost_usd),0)::float FROM autonomous_query_page_observations) AS provider_cost_usd,
         (SELECT COALESCE(AVG(elapsed_ms),0)::float FROM autonomous_query_page_observations) AS average_elapsed_ms,
         (SELECT COALESCE(AVG(retrieval_ms),0)::float FROM autonomous_query_page_observations) AS average_retrieval_ms,
         (SELECT COALESCE(AVG(processing_ms),0)::float FROM autonomous_query_page_observations) AS average_processing_ms,
         (SELECT COALESCE(AVG(marginal_utility_v2),0)::float FROM autonomous_query_page_observations) AS average_marginal_utility,
         (SELECT COUNT(*)::int FROM autonomous_query_page_observations WHERE continuation_decision_v2='{}'::jsonb) AS missing_decisions,
         (SELECT COUNT(*)::int FROM autonomous_query_page_observations WHERE resume_mode <> 'NONE') AS resumed_pages,
         (SELECT COUNT(*)::int FROM autonomous_query_page_observations WHERE deferred_reason IS NOT NULL) AS deferred_pages,
         (SELECT COUNT(*)::int FROM query_runs) AS runs,
         (SELECT COUNT(*)::int FROM query_runs WHERE continuation_status='RUNNING') AS running,
         (SELECT COUNT(*)::int FROM query_runs WHERE continuation_status='DEFERRED_QUOTA') AS deferred_quota,
         (SELECT COUNT(*)::int FROM query_runs WHERE continuation_status='DEFERRED_TIME') AS deferred_time,
         (SELECT COUNT(*)::int FROM query_runs WHERE continuation_status='COMPLETE') AS complete,
         (SELECT COUNT(*)::int FROM query_runs WHERE continuation_status='FAILED') AS failed,
         (SELECT COALESCE(SUM(pages_completed),0)::int FROM query_runs) AS pages_completed,
         (SELECT COALESCE(AVG(effective_max_pages),0)::float FROM query_runs) AS average_effective_max_pages,
         (SELECT COALESCE(SUM(run_quota_budget_units),0)::int FROM query_runs) AS run_quota_budget_units,
         (SELECT COALESCE(SUM(run_quota_consumed_units),0)::int FROM query_runs) AS run_quota_consumed_units,
         (SELECT COALESCE(SUM(resume_count),0)::int FROM query_runs) AS resume_count,
         (SELECT COALESCE(SUM(resume_rewalk_count),0)::int FROM query_runs) AS resume_rewalks,
         (SELECT COUNT(*)::int FROM query_runs WHERE continued_from_run_id IS NOT NULL) AS continuation_segments,
         (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(completed_at,now())-COALESCE(started_at,scheduled_at)))),0)::float FROM query_runs) AS elapsed_seconds,
         (SELECT COALESCE(SUM(last_cumulative),0)::int FROM (
            SELECT DISTINCT ON (query_run_id) cumulative_unique_creators AS last_cumulative
            FROM autonomous_query_page_observations
            ORDER BY query_run_id, page_number DESC
          ) latest) AS cumulative_unique_creators,
         (SELECT COALESCE(SUM(trading_confirmed),0)::int FROM query_runs) AS run_confirmed_creators,
         (SELECT COALESCE(SUM(quality_channels),0)::int FROM query_runs) AS run_quality_creators`,
    ),
    runner.query(
      `SELECT primary_reason, COUNT(*)::int AS count
       FROM autonomous_query_page_observations
       GROUP BY primary_reason ORDER BY count DESC, primary_reason`,
    ),
    runner.query(
      `SELECT COALESCE(last.stopping_reason,'UNKNOWN') AS reason, COUNT(*)::int AS count
       FROM query_runs qr
       LEFT JOIN LATERAL (
         SELECT stopping_reason
         FROM autonomous_query_page_observations p
         WHERE p.query_run_id=qr.id
         ORDER BY p.page_number DESC LIMIT 1
       ) last ON true
       GROUP BY 1 ORDER BY count DESC, reason`,
    ),
    runner.query(
      `SELECT qr.country,
              COUNT(DISTINCT qr.id)::int AS runs,
              COUNT(DISTINCT qr.query_id)::int AS queries_executed,
              (SELECT COUNT(*)::int FROM query_library ql WHERE lower(ql.country)=lower(qr.country)) AS queries_generated,
              COUNT(p.id)::int AS pages,
              COALESCE(SUM(p.quota_units),0)::int AS quota_units,
              COALESCE(SUM(p.marginal_new_creators),0)::int AS new_creators,
              COALESCE(SUM(p.marginal_confirmed_creators),0)::int AS confirmed_creators,
              COALESCE(SUM(p.marginal_quality_creators),0)::int AS quality_creators,
              COALESCE(AVG(CASE WHEN p.country_precision < 0.5 THEN 1.0 ELSE 0.0 END),0)::float AS wrong_country_share,
              COALESCE(AVG(p.duplicate_ratio),0)::float AS duplicate_rate,
              COUNT(DISTINCT qr.id) FILTER (WHERE qr.continuation_status IN ('RUNNING','DEFERRED_QUOTA','DEFERRED_TIME'))::int AS pending_continuations,
              -- Age is measured over pending runs only: a completed run must
              -- not make an idle country look like it has an old continuation.
              COALESCE(MAX(EXTRACT(EPOCH FROM (now()-COALESCE(qr.last_page_at,qr.started_at,qr.scheduled_at)))/60)
                FILTER (WHERE qr.continuation_status IN ('RUNNING','DEFERRED_QUOTA','DEFERRED_TIME')),0)::float AS oldest_pending_age_minutes
       FROM query_runs qr
       LEFT JOIN autonomous_query_page_observations p ON p.query_run_id=qr.id
       GROUP BY qr.country ORDER BY qr.country`,
    ),
    runner.query(
      `WITH pages AS (
         SELECT qr.country, p.query_run_id, p.page_number, p.created_at,
                (p.marginal_new_creators > 0 OR p.marginal_confirmed_creators > 0
                 OR p.marginal_quality_creators > 0 OR p.novel_candidate_terms > 0) AS productive
         FROM autonomous_query_page_observations p
         JOIN query_runs qr ON qr.id=p.query_run_id
       ), latest_run AS (
         SELECT DISTINCT ON (country) country, query_run_id
         FROM pages ORDER BY country, created_at DESC
       ), current_pages AS (
         SELECT p.country, p.page_number, p.productive
         FROM pages p JOIN latest_run l ON l.country=p.country AND l.query_run_id=p.query_run_id
       ), marked AS (
         SELECT country, page_number, productive,
                SUM(CASE WHEN productive THEN 1 ELSE 0 END)
                  OVER (PARTITION BY country ORDER BY page_number) AS productive_group
         FROM current_pages
       ), last_group AS (
         SELECT country, MAX(productive_group) AS productive_group FROM marked GROUP BY country
       )
       SELECT m.country, COUNT(*)::int AS zero_yield_streak
       FROM marked m JOIN last_group g ON g.country=m.country AND g.productive_group=m.productive_group
       WHERE NOT m.productive
       GROUP BY m.country ORDER BY m.country`,
    ),
    runner.query(
      `SELECT COALESCE(ql.generation_metadata->>'source','UNKNOWN') AS source,
              COUNT(DISTINCT qr.id)::int AS runs,
              COUNT(p.id)::int AS pages,
              COALESCE(SUM(p.marginal_new_creators),0)::int AS new_creators,
              COALESCE(SUM(p.marginal_confirmed_creators),0)::int AS confirmed_creators,
              COALESCE(SUM(p.marginal_quality_creators),0)::int AS quality_creators,
              CASE WHEN COUNT(p.id) > 0 THEN
                COUNT(p.id) FILTER (WHERE p.marginal_new_creators > 0 OR p.marginal_confirmed_creators > 0
                  OR p.marginal_quality_creators > 0 OR p.novel_candidate_terms > 0)::float / COUNT(p.id)
              ELSE 0 END AS acceptance_rate,
              CASE WHEN COALESCE(SUM(p.marginal_quality_creators),0) > 0 THEN
                COALESCE(SUM(p.provider_page_cost_usd),0)::float / SUM(p.marginal_quality_creators)
              ELSE 0 END AS cost_per_quality_creator
       FROM query_runs qr
       JOIN query_library ql ON ql.id=qr.query_id
       LEFT JOIN autonomous_query_page_observations p ON p.query_run_id=qr.id
       GROUP BY 1 ORDER BY 1`,
    ),
    runner.query(
      `WITH telemetry AS (
         SELECT provider,
                COUNT(*)::int AS calls,
                COUNT(*) FILTER (WHERE status='SUCCESS')::int AS successes,
                COUNT(*) FILTER (WHERE status='RATE_LIMITED')::int AS rate_limited,
                COUNT(*) FILTER (WHERE status='TIMEOUT')::int AS timeouts,
                COUNT(*) FILTER (WHERE status NOT IN ('SUCCESS','RATE_LIMITED','TIMEOUT','CANCELLED'))::int AS errors,
                COALESCE(AVG(latency_ms),0)::float AS average_latency_ms,
                COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms),0)::float AS p50_latency_ms,
                COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms),0)::float AS p95_latency_ms,
                COALESCE(SUM(actual_cost),0)::float AS cost_usd
         FROM provider_call_events
         WHERE occurred_at >= now()-interval '24 hours'
         GROUP BY provider
       ), usage AS (
         -- Official YouTube runs persist provider_key='youtube-search' while
         -- provider_call_events uses provider='youtube'. Normalize the run key
         -- so calls and pages join into one provider row instead of splitting
         -- into a calls-only row and a pages-only row.
         SELECT CASE WHEN provider_key='youtube-search' THEN 'youtube'
                     ELSE COALESCE(provider_key,'UNKNOWN') END AS provider,
                COALESCE(SUM(pages_completed),0)::int AS pages,
                COALESCE(SUM(quota_used),0)::int AS quota_units,
                COALESCE(SUM(provider_cost_usd),0)::float AS provider_cost_usd
         FROM query_runs GROUP BY 1
       )
       SELECT COALESCE(t.provider,u.provider) AS provider,
              COALESCE(t.calls,0)::int AS calls,
              COALESCE(t.successes,0)::int AS successes,
              COALESCE(t.errors,0)::int AS errors,
              COALESCE(t.rate_limited,0)::int AS rate_limited,
              COALESCE(t.timeouts,0)::int AS timeouts,
              COALESCE(t.average_latency_ms,0)::float AS average_latency_ms,
              COALESCE(t.p50_latency_ms,0)::float AS p50_latency_ms,
              COALESCE(t.p95_latency_ms,0)::float AS p95_latency_ms,
              COALESCE(t.cost_usd,0)::float AS cost_usd,
              COALESCE(u.pages,0)::int AS pages,
              COALESCE(u.quota_units,0)::int AS quota_units,
              COALESCE(u.provider_cost_usd,0)::float AS provider_cost_usd
       FROM telemetry t FULL OUTER JOIN usage u ON t.provider=u.provider
       ORDER BY 1`,
    ),
    runner.query(
      `SELECT COUNT(*)::int AS calls,
              COALESCE(SUM(attempts),0)::int AS attempts,
              COUNT(*) FILTER (WHERE status='BUDGET_SKIPPED')::int AS budget_skips,
              COUNT(*) FILTER (WHERE status='SUCCEEDED')::int AS successes,
              COUNT(*) FILTER (WHERE status='FAILED')::int AS failures,
              COALESCE(SUM(actual_cost_microunits),0)::bigint AS actual_cost
       FROM native_vocabulary_ai_runs WHERE budget_day=$1`,
      [getYouTubeQuotaDay()],
    ),
    runner.query(
      `SELECT country, COUNT(*)::int AS calls,
              COALESCE(SUM(actual_cost_microunits),0)::bigint AS actual_cost
       FROM native_vocabulary_ai_runs WHERE budget_day=$1
       GROUP BY country ORDER BY country`,
      [getYouTubeQuotaDay()],
    ),
    runner.query(
      `SELECT COUNT(*)::int AS observations,
              COUNT(*) FILTER (WHERE promotion_eligible)::int AS promotion_eligible
       FROM terminology_observations`,
    ),
    runner.query(
      `SELECT lifecycle_status, COUNT(*)::int AS count
       FROM canonical_trading_terms GROUP BY lifecycle_status ORDER BY lifecycle_status`,
    ),
    runner.query(
      `SELECT COUNT(*) FILTER (WHERE event_type='PROMOTION')::int AS promotions,
              COUNT(*) FILTER (WHERE event_type='DEMOTION')::int AS demotions
       FROM terminology_lifecycle_events`,
    ),
    runner.query(
      `SELECT COALESCE(SUM(unique_creators),0)::int AS unique_creators,
              COALESCE(SUM(wrong_country_creators),0)::int AS wrong_country_creators,
              COALESCE(SUM(needs_review_creators),0)::int AS needs_review_creators
       FROM terminology_performance`,
    ),
  ]);

  const pageRunRow = (pageRun.rows || [])[0] || {};
  const aiRow = (ai.rows || [])[0] || {};
  const lifecycleRow = (lifecycle.rows || [])[0] || {};
  const lifecycleEventsRow = (lifecycleEvents.rows || [])[0] || {};
  const lifecyclePerformanceRow = (lifecyclePerformance.rows || [])[0] || {};
  const streakByCountry = new Map(
    (countryStreaks.rows || []).map(row => [String(row.country).toLowerCase(), Number(row.zero_yield_streak || 0)]),
  );
  const stages: Record<string, number> = {};
  for (const row of lifecycleStages.rows || []) {
    stages[String(row.lifecycle_status)] = Number(row.count || 0);
  }
  // Conversion is the share of non-demoted terms that reached a given stage.
  // A term at PROVEN_SEARCH_TERM has passed every earlier stage, so counts are
  // cumulative from the most advanced stage backwards.
  const stageOrder = ['CANDIDATE', 'OBSERVED', 'MULTI_CREATOR_VALIDATED', 'SEARCH_TRIAL', 'PROVEN_SEARCH_TERM'];
  const nonDemoted = stageOrder.reduce((sum, stage) => sum + (stages[stage] || 0), 0);
  const stageConversion: Record<string, number> = {};
  let reached = 0;
  for (let index = stageOrder.length - 1; index >= 0; index -= 1) {
    reached += stages[stageOrder[index]] || 0;
    stageConversion[stageOrder[index]] = nonDemoted > 0 ? reached / nonDemoted : 0;
  }
  const lifecycleUnique = Number(lifecyclePerformanceRow.unique_creators || 0);
  const observations = Number(lifecycleRow.observations || 0);
  const promotionEligible = Number(lifecycleRow.promotion_eligible || 0);

  return {
    generatedAt: new Date().toISOString(),
    page: {
      pages: Number(pageRunRow.pages || 0),
      pagesLast24h: Number(pageRunRow.pages_last_24h || 0),
      rawResults: Number(pageRunRow.raw_results || 0),
      distinctCreators: Number(pageRunRow.distinct_creators || 0),
      newCreators: Number(pageRunRow.new_creators || 0),
      confirmedCreators: Number(pageRunRow.confirmed_creators || 0),
      qualityCreators: Number(pageRunRow.quality_creators || 0),
      crossPageRepeats: Number(pageRunRow.cross_page_repeats || 0),
      averageDuplicateRatio: Number(pageRunRow.average_duplicate_ratio || 0),
      averageCountryPrecision: Number(pageRunRow.average_country_precision || 0),
      averageTradingPrecision: Number(pageRunRow.average_trading_precision || 0),
      averageRelevance: Number(pageRunRow.average_relevance || 0),
      quotaUnits: Number(pageRunRow.quota_units || 0),
      providerCostUsd: Number(pageRunRow.provider_cost_usd || 0),
      averageElapsedMs: Number(pageRunRow.average_elapsed_ms || 0),
      averageRetrievalMs: Number(pageRunRow.average_retrieval_ms || 0),
      averageProcessingMs: Number(pageRunRow.average_processing_ms || 0),
      averageMarginalUtility: Number(pageRunRow.average_marginal_utility || 0),
      missingDecisions: Number(pageRunRow.missing_decisions || 0),
      resumedPages: Number(pageRunRow.resumed_pages || 0),
      deferredPages: Number(pageRunRow.deferred_pages || 0),
      decisions: (pageDecisions.rows || []).map(row => ({
        reason: String(row.primary_reason || 'UNKNOWN'),
        count: Number(row.count || 0),
      })),
    },
    run: {
      runs: Number(pageRunRow.runs || 0),
      running: Number(pageRunRow.running || 0),
      deferredQuota: Number(pageRunRow.deferred_quota || 0),
      deferredTime: Number(pageRunRow.deferred_time || 0),
      complete: Number(pageRunRow.complete || 0),
      failed: Number(pageRunRow.failed || 0),
      pagesCompleted: Number(pageRunRow.pages_completed || 0),
      averageEffectiveMaxPages: Number(pageRunRow.average_effective_max_pages || 0),
      runQuotaBudgetUnits: Number(pageRunRow.run_quota_budget_units || 0),
      runQuotaConsumedUnits: Number(pageRunRow.run_quota_consumed_units || 0),
      cumulativeUniqueCreators: Number(pageRunRow.cumulative_unique_creators || 0),
      confirmedCreators: Number(pageRunRow.run_confirmed_creators || 0),
      qualityCreators: Number(pageRunRow.run_quality_creators || 0),
      resumeCount: Number(pageRunRow.resume_count || 0),
      resumeRewalks: Number(pageRunRow.resume_rewalks || 0),
      continuationSegments: Number(pageRunRow.continuation_segments || 0),
      elapsedSeconds: Number(pageRunRow.elapsed_seconds || 0),
      stopReasons: (runStopReasons.rows || []).map(row => ({
        reason: String(row.reason || 'UNKNOWN'),
        count: Number(row.count || 0),
      })),
    },
    countries: (countries.rows || []).map(row => ({
      country: String(row.country),
      queriesGenerated: Number(row.queries_generated || 0),
      queriesExecuted: Number(row.queries_executed || 0),
      runs: Number(row.runs || 0),
      pages: Number(row.pages || 0),
      quotaUnits: Number(row.quota_units || 0),
      newCreators: Number(row.new_creators || 0),
      confirmedCreators: Number(row.confirmed_creators || 0),
      qualityCreators: Number(row.quality_creators || 0),
      wrongCountryShare: Number(row.wrong_country_share || 0),
      duplicateRate: Number(row.duplicate_rate || 0),
      zeroYieldStreak: streakByCountry.get(String(row.country).toLowerCase()) || 0,
      pendingContinuations: Number(row.pending_continuations || 0),
      oldestPendingAgeMinutes: Number(row.oldest_pending_age_minutes || 0),
    })),
    sources: (sources.rows || []).map(row => ({
      source: String(row.source || 'UNKNOWN'),
      runs: Number(row.runs || 0),
      pages: Number(row.pages || 0),
      newCreators: Number(row.new_creators || 0),
      confirmedCreators: Number(row.confirmed_creators || 0),
      qualityCreators: Number(row.quality_creators || 0),
      acceptanceRate: Number(row.acceptance_rate || 0),
      costPerQualityCreator: Number(row.cost_per_quality_creator || 0),
    })),
    providers: (providers.rows || []).map(row => {
      const calls = Number(row.calls || 0);
      const successes = Number(row.successes || 0);
      const errors = Number(row.errors || 0);
      const rateLimited = Number(row.rate_limited || 0);
      const timeouts = Number(row.timeouts || 0);
      return {
        provider: String(row.provider || 'UNKNOWN'),
        calls,
        successes,
        errors,
        rateLimited,
        timeouts,
        successRate: calls > 0 ? successes / calls : 0,
        errorRate: calls > 0 ? errors / calls : 0,
        rateLimitRate: calls > 0 ? rateLimited / calls : 0,
        timeoutRate: calls > 0 ? timeouts / calls : 0,
        pages: Number(row.pages || 0),
        quotaUnits: Number(row.quota_units || 0),
        costUsd: Number(row.cost_usd || 0),
        providerCostUsd: Number(row.provider_cost_usd || 0),
        p50LatencyMs: Number(row.p50_latency_ms || 0),
        p95LatencyMs: Number(row.p95_latency_ms || 0),
      };
    }),
    ai: {
      calls: Number(aiRow.calls || 0),
      attempts: Number(aiRow.attempts || 0),
      budgetSkips: Number(aiRow.budget_skips || 0),
      successes: Number(aiRow.successes || 0),
      failures: Number(aiRow.failures || 0),
      actualCostMicrounits: Number(aiRow.actual_cost || 0),
      countries: (aiCountries.rows || []).map(row => ({
        country: String(row.country || 'UNKNOWN'),
        calls: Number(row.calls || 0),
        actualCostMicrounits: Number(row.actual_cost || 0),
      })),
    },
    lifecycle: {
      observations,
      promotionEligible,
      promotionEligibleShare: observations > 0 ? promotionEligible / observations : 0,
      stages,
      stageConversion,
      promotions: Number(lifecycleEventsRow.promotions || 0),
      demotions: Number(lifecycleEventsRow.demotions || 0),
      wrongCountryShare: lifecycleUnique > 0
        ? Number(lifecyclePerformanceRow.wrong_country_creators || 0) / lifecycleUnique
        : 0,
      reviewShare: lifecycleUnique > 0
        ? Number(lifecyclePerformanceRow.needs_review_creators || 0) / lifecycleUnique
        : 0,
    },
  };
}
