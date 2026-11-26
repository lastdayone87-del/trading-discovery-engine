import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ensureProviderEventIndexes } from './dbCore';
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

async function createSchema(): Promise<void> {
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
    CREATE INDEX idx_provider_events_time ON provider_call_events (occurred_at DESC);
    CREATE INDEX idx_provider_events_provider_operation_time ON provider_call_events (provider, operation, occurred_at DESC);
  `);
}

async function seedData(): Promise<void> {
  const db = requirePool();
  await db.query(`
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

maybe('migration 209 creates on an empty table, re-adopts, and the hot reads use the indexes', async () => {
  pool = new pg.Pool({ connectionString: dedicatedUrl, max: 4 });
  await createSchema();
  const db = requirePool();
  const migration = readFileSync(new URL('./db/migrations/209_provider_event_indexes.sql', import.meta.url), 'utf8');
  // First run must exercise the migration's empty-table CREATE path.
  await db.query(migration);
  const created = await db.query(`SELECT c.relname, i.indisvalid, i.indisready FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid WHERE c.relname IN ('idx_provider_events_gemini_active_org_time','idx_provider_events_groq_rate_org_time','idx_provider_events_rate_provider_time','idx_provider_events_run_id')`);
  assert.equal(created.rowCount, 4);
  assert.ok(created.rows.every(row => row.indisvalid === true && row.indisready === true));
  // Second run must adopt the same indexes without rebuilding.
  await db.query(migration);
  await seedData();

  const cases: Array<[string, string]> = [
    [`SELECT occurred_at FROM provider_call_events WHERE provider='gemini' AND request_metadata->>'geminiOrg'='gemini-project-1' AND COALESCE(request_metadata->>'geminiCapacityDeferral','') <> 'true' ORDER BY occurred_at DESC LIMIT 1`, 'idx_provider_events_gemini_active_org_time'],
    [`SELECT occurred_at, request_metadata->>'quotaScope' AS quota_scope, MAX((request_metadata->>'cooldownUntilMs')::bigint) FILTER (WHERE request_metadata->>'cooldownUntilMs' ~ '^[0-9]+$') OVER () AS cooldown_until_ms FROM provider_call_events WHERE provider='gemini' AND status='RATE_LIMITED' AND request_metadata->>'geminiOrg'='gemini-project-1' AND COALESCE(request_metadata->>'geminiCapacityDeferral','') <> 'true' AND occurred_at>=now()-interval '2 days' ORDER BY occurred_at DESC LIMIT 1`, 'idx_provider_events_gemini_active_org_time'],
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

maybe('boot repair rebuilds an index with a valid but wrong key order', async () => {
  const db = requirePool();
  await db.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_provider_events_run_id`);
  await db.query(`CREATE INDEX idx_provider_events_run_id ON provider_call_events (status, operation, provider, run_id) WHERE run_id IS NOT NULL`);
  await ensureProviderEventIndexes(db);
  const definition = await db.query(`SELECT pg_get_indexdef(to_regclass('public.idx_provider_events_run_id')) AS definition`);
  assert.match(definition.rows[0].definition, /USING btree \(run_id, provider, operation, status\)/);
});
