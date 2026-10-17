/**
 * Day-7 pilot status check — READ-ONLY.
 *
 * Prints a single JSON snapshot of the native-terminology loop state for the
 * day-7 sustainment-pilot review:
 * - kill-switch state (raw app_settings value + interpreted default-ON state)
 * - serving surface: search-eligible trial/proven terms per country
 * - pilot-country coverage (six-country plan)
 * - discovery indicators: observations with real language context, native
 *   evidence status, projections/attribution rows (Track B criteria)
 * - lifecycle events and guardrail events for the last 7 days
 * - yield snapshot from terminology_performance, clearly labelled:
 *     * confirmed_incl_repeats / quota  = raw (repeat sightings included), and
 *     * new_creators / quota            = upper-bound proxy for the promotion
 *       bar, which sums the term's full persisted performance ledger and uses
 *       min(confirmed_trading_creators, new_creators) — no execution-time
 *       window exists today, so read it as an upper bound, not a windowed rate.
 *
 * Usage: DATABASE_URL=... npx tsx scripts/terminologyPilotStatus.ts
 *
 * Safety: connects with a standalone single-connection `pg` pool (never the
 * app's `getDb()` bootstrap, whose initialization runs migrations/seeding),
 * opens one repeatable-read, read-only transaction for a stable snapshot, and
 * issues SELECT statements only.
 */
import pg, { type PoolClient } from 'pg';
import { TERMINOLOGY_KILL_SWITCH_KEY, isTerminologyKillSwitchActive } from '../server/terminologyKillSwitch';

const PILOT_COUNTRIES = ['Germany', 'France', 'United Kingdom', 'United States', 'Canada', 'Australia'];

const per1k = (numerator: number, quota: number): number | null =>
  quota > 0 ? Number(((1000 * numerator) / quota).toFixed(1)) : null;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({
    connectionString: url,
    ssl: process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
    max: 1,
  });
  let clientRef: PoolClient | undefined;
  let txOpen = false;
  try {
    const client = await pool.connect();
    clientRef = client;
    // One stable snapshot for the whole report: repeatable-read + read-only.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    txOpen = true;

    const identity = await client.query('SELECT current_database() AS db, current_user AS usr, now() AS at');
    const killRow = await client.query(`SELECT setting_value FROM app_settings WHERE setting_key=$1`, [TERMINOLOGY_KILL_SWITCH_KEY]);
    const killRaw = killRow.rows[0]?.setting_value ?? null;
    // Reuse the production semantics without the app pool (the injected reader
    // keeps this script free of migration/seed bootstrap).
    const killActive = await isTerminologyKillSwitchActive({ readSetting: async () => killRaw ?? '' });

    const serving = await client.query(`
      SELECT country,
             count(*)::int AS eligible_terms,
             count(*) FILTER (WHERE lifecycle_status='SEARCH_TRIAL')::int AS trial_terms,
             count(*) FILTER (WHERE lifecycle_status='PROVEN_SEARCH_TERM')::int AS proven_terms
      FROM canonical_trading_terms
      WHERE search_eligible = true AND lifecycle_status IN ('SEARCH_TRIAL','PROVEN_SEARCH_TERM')
      GROUP BY country ORDER BY country`);

    const observations = await client.query(`
      SELECT count(*)::int AS observations_7d,
             count(*) FILTER (WHERE term_language IS NOT NULL AND term_language <> 'und')::int AS with_language_7d,
             count(*) FILTER (WHERE native_evidence_status IS NOT NULL)::int AS with_native_status_7d,
             count(*) FILTER (WHERE is_code_switched)::int AS code_switched_7d
      FROM terminology_observations WHERE observed_at > now() - interval '7 days'`);

    const projections = await client.query(`
      SELECT (SELECT count(*) FROM country_native_evidence_projections)::int AS projections,
             (SELECT count(*) FROM country_native_performance_attribution)::int AS attribution`);

    const lifecycle = await client.query(`
      SELECT event_type, count(*)::int AS events, max(created_at) AS latest
      FROM terminology_lifecycle_events WHERE created_at > now() - interval '7 days'
      GROUP BY event_type ORDER BY events DESC`);

    const guardrails = await client.query(`
      SELECT guardrail, action, count(*)::int AS events
      FROM terminology_guardrail_events WHERE occurred_at > now() - interval '7 days'
      GROUP BY guardrail, action ORDER BY events DESC`);

    const performance = await client.query(`
      SELECT t.country,
             sum(p.confirmed_trading_creators)::int AS confirmed_incl_repeats,
             sum(p.new_creators)::int AS new_creators,
             sum(p.quota_consumed)::int AS quota_consumed
      FROM terminology_performance p
      JOIN canonical_trading_terms t ON t.id = p.canonical_term_id
      WHERE t.search_eligible = true
      GROUP BY t.country ORDER BY t.country`);

    await client.query('COMMIT');
    txOpen = false;

    const servingRows = serving.rows as Array<{ country: string; eligible_terms: number; trial_terms: number; proven_terms: number }>;
    const coverage = Object.fromEntries(
      PILOT_COUNTRIES.map(country => {
        const row = servingRows.find(r => r.country === country);
        return [country, row ? { eligible_terms: row.eligible_terms, trial_terms: row.trial_terms, proven_terms: row.proven_terms } : { eligible_terms: 0, trial_terms: 0, proven_terms: 0 }];
      })
    );

    const report = {
      generated_at: identity.rows[0]?.at ?? null,
      database: identity.rows[0]?.db ?? null,
      database_user: identity.rows[0]?.usr ?? null,
      kill_switch: {
        key: TERMINOLOGY_KILL_SWITCH_KEY,
        raw_value: killRaw,
        active: killActive,
        semantics: "default-ON: loop runs unless the setting is exactly 'true'",
      },
      serving_eligible_terms_by_country: servingRows,
      pilot_country_coverage: coverage,
      discovery_indicators_7d: observations.rows[0] ?? null,
      projections: projections.rows[0] ?? null,
      lifecycle_events_7d: lifecycle.rows,
      guardrail_events_7d: guardrails.rows,
      yield_snapshot_raw: (performance.rows as Array<{ country: string; confirmed_incl_repeats: number; new_creators: number; quota_consumed: number }>).map(row => ({
        country: row.country,
        confirmed_incl_repeats: row.confirmed_incl_repeats,
        new_creators: row.new_creators,
        quota_consumed: row.quota_consumed,
        per_1k_confirmed_incl_repeats: per1k(row.confirmed_incl_repeats, row.quota_consumed),
        per_1k_new_creators: per1k(row.new_creators, row.quota_consumed),
      })),
      notes: [
        "Raw yield includes repeat sightings; the promotion bar sums the term's full persisted performance ledger and uses min(confirmed_trading_creators, new_creators) — no execution-time window exists today, so per_1k_new_creators is an upper bound.",
        'This script is read-only and never writes.',
      ],
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (clientRef) {
      if (txOpen) await clientRef.query('ROLLBACK').catch(() => undefined);
      clientRef.release();
    }
    await pool.end().catch(() => undefined);
  }
}

main().catch(err => {
  console.error(`[terminologyPilotStatus] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
