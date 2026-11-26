import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import pg from 'pg';
import type { Pool } from 'pg';

/**
 * Disposable-Postgres verification for the provider-call capacity indexes.
 * Runs only against the CI service database; skips without the URL.
 */
const dedicatedUrl = process.env.PROVIDER_EVENT_TEST_DATABASE_URL;

test('provider event index tests require a dedicated database (skipped otherwise)', () => {
  if (!dedicatedUrl) console.log('SKIP: set PROVIDER_EVENT_TEST_DATABASE_URL to run the provider event index tests.');
  assert.ok(true);
});

const maybe = dedicatedUrl ? test : test.skip;
let pool: Pool | null = null;

function requirePool(): Pool {
  assert.ok(pool, 'pool must be initialized by the schema test');
  return pool;
}

function planNodes(value: unknown, nodes: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) planNodes(item, nodes);
  } else if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    if (typeof node['Node Type'] === 'string') nodes.push(node);
    for (const child of Object.values(node)) planNodes(child, nodes);
  }
  return nodes;
}

function assertUsesIndex(plan: unknown, indexName: string): void {
  const nodes = planNodes(plan);
  assert.ok(nodes.some(node => String(node['Index Name'] || '') === indexName), `plan must use ${indexName}`);
}

async function setup(): Promise<void> {
  const db = requirePool();
  await db.query(`DROP TABLE IF EXISTS provider_call_events`);
  await db.query(`
    CREATE TABLE provider_call_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider text NOT NULL,
      operation text,
      run_id text,
      status text NOT NULL,
      latency_ms integer NOT NULL DEFAULT 0,
      request_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO provider_call_events(provider, operation, status, request_metadata, occurred_at, run_id)
    SELECT 'gemini', 'multilingual-semantic-classification', 'SUCCESS',
           jsonb_build_object('geminiOrg','gemini-project-'||(1+(g%5))::text),
           now()-((g%1440)::text||' minutes')::interval,
           'run-gemini-'||(g%100)::text
    FROM generate_series(1,50000) g;
    INSERT INTO provider_call_events(provider, operation, status, request_metadata, occurred_at)
    SELECT 'gemini', 'multilingual-semantic-classification', 'TRANSIENT_ERROR',
           jsonb_build_object('geminiOrg','gemini-project-'||(1+(g%5))::text,'geminiCapacityDeferral','true'),
           now()-((g%1440)::text||' minutes')::interval
    FROM generate_series(1,20000) g;
    INSERT INTO provider_call_events(provider, operation, status, request_metadata, occurred_at)
    SELECT 'gemini', 'multilingual-semantic-classification', 'RATE_LIMITED',
           jsonb_build_object('geminiOrg','gemini-project-'||g::text,'quotaScope','DAILY','cooldownUntilMs',(extract(epoch from now())+86400)::bigint*1000),
           now()-((g)::text||' hours')::interval
    FROM generate_series(1,5) g;
    INSERT INTO provider_call_events(provider, operation, status, request_metadata, occurred_at)
    SELECT 'groq', 'multilingual-semantic-classification', 'RATE_LIMITED',
           jsonb_build_object('groqOrg','groq-org-'||(1+(g%6))::text,'groqRoute','groq-'||(1+(g%6))::text),
           now()-((g%1440)::text||' minutes')::interval
    FROM generate_series(1,10000) g;
    INSERT INTO provider_call_events(provider, operation, status, request_metadata, occurred_at)
    SELECT 'groq', 'multilingual-semantic-classification', 'RATE_LIMITED',
           jsonb_build_object('groqOrg','groq-org-'||(1+(g%6))::text,'groqCooldownDeferral','true'),
           now()-((g%1440)::text||' minutes')::interval
    FROM generate_series(1,2000) g;
    INSERT INTO provider_call_events(provider, operation, status, request_metadata, occurred_at)
    SELECT 'youtube', 'search', 'SUCCESS', '{}'::jsonb,
           now()-((g%1440)::text||' minutes')::interval
    FROM generate_series(1,10000) g;
    ANALYZE provider_call_events;
  `);
}

maybe('migration 209 adopts all provider-event indexes and the hot reads use them', async () => {
  pool = new pg.Pool({ connectionString: dedicatedUrl, max: 4 });
  await setup();
  const db = requirePool();
  await db.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_provider_events_gemini_active_org_time ON public.provider_call_events ((request_metadata->>'geminiOrg'), occurred_at DESC) WHERE provider='gemini' AND COALESCE(request_metadata->>'geminiCapacityDeferral','') <> 'true'`);
  await db.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_provider_events_groq_rate_org_time ON public.provider_call_events ((request_metadata->>'groqOrg'), occurred_at DESC) WHERE provider='groq' AND status='RATE_LIMITED' AND COALESCE(request_metadata->>'groqCooldownDeferral','') <> 'true'`);
  await db.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_provider_events_rate_provider_time ON public.provider_call_events (provider, occurred_at DESC) WHERE status='RATE_LIMITED'`);
  await db.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_provider_events_run_id ON public.provider_call_events (run_id, provider, operation, status) WHERE run_id IS NOT NULL`);
  await db.query(`ANALYZE provider_call_events`);

  const migration = readFileSync(new URL('./db/migrations/209_provider_event_indexes.sql', import.meta.url), 'utf8');
  await db.query(migration);

  const cases: Array<[string, string]> = [
    [`SELECT occurred_at FROM provider_call_events WHERE provider='gemini' AND request_metadata->>'geminiOrg'='gemini-project-1' AND COALESCE(request_metadata->>'geminiCapacityDeferral','') <> 'true' ORDER BY occurred_at DESC LIMIT 1`, 'idx_provider_events_gemini_active_org_time'],
    [`SELECT occurred_at FROM provider_call_events WHERE provider='groq' AND status='RATE_LIMITED' AND COALESCE(request_metadata->>'groqCooldownDeferral','') <> 'true' AND request_metadata->>'groqOrg'='groq-org-1' ORDER BY occurred_at DESC LIMIT 1`, 'idx_provider_events_groq_rate_org_time'],
    [`SELECT occurred_at FROM provider_call_events WHERE provider='gemini' AND status='RATE_LIMITED' AND occurred_at>=now()-interval '2 days' ORDER BY occurred_at DESC LIMIT 1`, 'idx_provider_events_rate_provider_time'],
    [`SELECT COUNT(*)::int FROM provider_call_events WHERE run_id='run-gemini-1' AND provider='gemini' AND operation='multilingual-semantic-classification' AND status='SUCCESS'`, 'idx_provider_events_run_id'],
  ];
  for (const [sql, indexName] of cases) {
    const plan = await db.query(`EXPLAIN (FORMAT JSON) ${sql}`);
    assertUsesIndex(plan.rows[0]['QUERY PLAN'], indexName);
  }
});

after(async () => {
  if (!pool) return;
  try { await pool.query(`DROP TABLE IF EXISTS provider_call_events`); } finally { await pool.end(); }
});
