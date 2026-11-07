import { getDb } from './dbCore';
import { providerCooldownExpiryMs } from './providerResilience';

/**
 * Credential-free semantic provider route health. Exposed through the
 * existing authorized `/api/provider-metrics` endpoint so operators can see
 * which account/project is cooling, quarantined, or failing without reading
 * container logs or credentials. Read-only: it never calls a provider.
 *
 * Status combines two sources:
 *  - in-process state (Groq restricted-route quarantine and 429 cooldown),
 *  - the persisted `provider_call_events` ledger, so a cooldown armed by
 *    another replica or an earlier process is visible here too.
 */
const COOLDOWN_LOOKBACK_DAYS = 7;
const RECENT_FAILURE_WINDOW_HOURS = 6;
/**
 * The operator dashboard polls /api/provider-metrics every 15 seconds. The
 * ledger aggregates are expensive (seven-day cooldown scan plus a grouped
 * failure scan), so cache the raw rows for one polling interval. In-process
 * route state and expiry arithmetic stay live on every call.
 */
const LEDGER_CACHE_MS = 15_000;
let ledgerCache: { cachedAtMs: number; cooldowns: any[]; recentFailures: any[] } | undefined;

/** Test-only reset for the ledger aggregate cache. */
export function resetSemanticRouteHealthCacheForTests(): void {
  ledgerCache = undefined;
}

function cooldownRows(rows: any[]): Map<string, { lastAt?: unknown; declaredUntil?: unknown }> {
  const map = new Map<string, { lastAt?: unknown; declaredUntil?: unknown }>();
  for (const row of rows) {
    const key = `${row.provider}\u0000${row.org || ''}`;
    map.set(key, { lastAt: row.last_at, declaredUntil: row.declared_until });
  }
  return map;
}

async function safeQuery(sql: string, values?: unknown[]): Promise<any[]> {
  try {
    const db = await getDb();
    const result = await db.query(sql, values);
    return result.rows;
  } catch {
    // Diagnostics must never fail a metrics request: an unavailable ledger
    // degrades to in-process state.
    return [];
  }
}

export async function getSemanticRouteHealth(nowMs: number = Date.now()): Promise<any> {
  const [groqModule, geminiModule] = await Promise.all([
    import('./evidenceEngine/providers/GroqSemanticProvider'),
    import('./evidenceEngine/providers/GeminiSemanticProvider'),
  ]);

  const [cooldowns, recentFailures] = await (async () => {
    const now = Date.now();
    if (ledgerCache && now - ledgerCache.cachedAtMs >= 0 && now - ledgerCache.cachedAtMs < LEDGER_CACHE_MS) {
      return [ledgerCache.cooldowns, ledgerCache.recentFailures] as const;
    }
    const [nextCooldowns, nextRecentFailures] = await Promise.all([
      safeQuery(
        `SELECT provider,
                COALESCE(NULLIF(request_metadata->>'geminiOrg',''), NULLIF(request_metadata->>'groqOrg',''), '') AS org,
                MAX(occurred_at) AS last_at,
                MAX((request_metadata->>'cooldownUntilMs')::bigint)
                  FILTER (WHERE request_metadata->>'cooldownUntilMs' ~ '^[0-9]+$') AS declared_until
           FROM provider_call_events
          WHERE status='RATE_LIMITED'
            AND provider IN ('gemini','groq','gemini-free')
            AND occurred_at >= now() - ($1 || ' days')::interval
            AND COALESCE(request_metadata->>'groqCooldownDeferral','') <> 'true'
            AND COALESCE(request_metadata->>'geminiFreeCooldownDeferral','') <> 'true'
          GROUP BY provider, org`,
        [String(COOLDOWN_LOOKBACK_DAYS)],
      ),
      safeQuery(
        `SELECT provider,
                COALESCE(NULLIF(request_metadata->>'groqRoute',''), NULLIF(request_metadata->>'geminiRoute',''), 'legacy') AS route,
                COALESCE(NULLIF(request_metadata->>'groqOrg',''), NULLIF(request_metadata->>'geminiOrg',''), '') AS org,
                status, error_class,
                (COALESCE(request_metadata->>'groqCooldownDeferral','')='true'
                  OR COALESCE(request_metadata->>'geminiFreeCooldownDeferral','')='true') AS cooldown_deferral,
                COUNT(*)::int AS events,
                MAX(occurred_at) AS last_at,
                COUNT(*) FILTER (WHERE request_metadata->>'groqRouteDisabled'='true')::int AS route_disabled_events
           FROM provider_call_events
          WHERE occurred_at >= now() - ($1 || ' hours')::interval
            AND status <> 'SUCCESS'
          GROUP BY provider, route, org, status, error_class, cooldown_deferral
          ORDER BY MAX(occurred_at) DESC
          LIMIT 100`,
        [String(RECENT_FAILURE_WINDOW_HOURS)],
      ),
    ]);
    ledgerCache = { cachedAtMs: now, cooldowns: nextCooldowns, recentFailures: nextRecentFailures };
    return [nextCooldowns, nextRecentFailures] as const;
  })();
  const ledger = cooldownRows(cooldowns);

  const groqRoutes = groqModule.getGroqRouteHealth(nowMs).map(route => {
    const persisted = ledger.get(`groq\u0000${route.org}`);
    const persistedCooldownUntilMs = providerCooldownExpiryMs(
      persisted?.lastAt,
      persisted?.declaredUntil,
      groqModule.groqRateLimitCooldownMs(),
      nowMs,
    );
    return {
      route: route.route,
      org: route.org,
      status: route.status !== 'healthy'
        ? route.status
        : persistedCooldownUntilMs !== undefined ? 'cooling' : 'healthy',
      cooldownRemainingMs: Math.max(route.cooldownRemainingMs, persistedCooldownUntilMs ? persistedCooldownUntilMs - nowMs : 0),
      disabledRemainingMs: route.disabledRemainingMs,
      persistedCooldownUntilMs: persistedCooldownUntilMs ?? null,
    };
  });

  const geminiCooldownMs = Number(process.env.GEMINI_SEMANTIC_RATE_LIMIT_COOLDOWN_MS || 90_000);
  const geminiRoutes = geminiModule.configuredGeminiRoutes().map(route => {
    const org = geminiModule.geminiRouteOrg(route);
    const persisted = ledger.get(`gemini\u0000${org}`);
    const cooldownUntilMs = providerCooldownExpiryMs(
      persisted?.lastAt,
      persisted?.declaredUntil,
      Number.isFinite(geminiCooldownMs) && geminiCooldownMs >= 0 ? geminiCooldownMs : 90_000,
      nowMs,
    );
    return {
      route: route.id,
      org,
      status: cooldownUntilMs !== undefined ? 'cooling' : 'healthy',
      cooldownUntilMs: cooldownUntilMs ?? null,
      cooldownRemainingMs: cooldownUntilMs !== undefined ? cooldownUntilMs - nowMs : 0,
    };
  });

  return {
    generatedAt: new Date(nowMs).toISOString(),
    semanticProvider: process.env.SEMANTIC_PROVIDER_FORCE_GEMINI === 'true'
      ? 'gemini'
      : process.env.SEMANTIC_PROVIDER || 'gemini',
    windowHours: RECENT_FAILURE_WINDOW_HOURS,
    groq: {
      routeCount: groqRoutes.length,
      missingOrgLabels: groqModule.missingGroqOrgLabels(),
      routes: groqRoutes,
    },
    gemini: {
      routeCount: geminiRoutes.length,
      missingOrgLabels: geminiModule.missingGeminiOrgLabels(),
      routes: geminiRoutes,
    },
    recentFailures,
  };
}
