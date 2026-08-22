import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { buildRetrievalConfiguration } from './retrievalConfiguration';
import { evaluateShadowRetrievalRecommendation } from './retrievalPolicyShadow';

class FakeRunner {
  readonly queries: Array<{ sql: string; params?: unknown[] }> = [];
  constructor(
    private readonly parentExists: boolean,
    private readonly failShadowInsert = false
  ) {}

  async query(sql: string, params?: unknown[]) {
    this.queries.push({ sql, params });
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized.startsWith('select 1 from discovery_neighborhoods')) {
      return this.parentExists ? { rowCount: 1, rows: [{ '?column?': 1 }] } : { rowCount: 0, rows: [] };
    }
    if (normalized.startsWith('insert into retrieval_policy_shadow_recommendations')) {
      if (this.failShadowInsert) throw new Error('simulated shadow foreign-key violation');
      return { rowCount: 1, rows: [] };
    }
    if (normalized === 'select 42') return { rowCount: 1, rows: [{ answer: 42 }] };
    if (normalized.startsWith('select ')) return { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [] };
  }
}

function configs() {
  return {
    controlConfig: buildRetrievalConfiguration({ searchOrdering: 'RELEVANCE', retrievalLane: 'VIDEO', requestedPageDepth: 1 }),
    executedConfig: buildRetrievalConfiguration({ searchOrdering: 'DATE', retrievalLane: 'VIDEO', requestedPageDepth: 2 })
  };
}

function sqls(runner: FakeRunner): string[] {
  return runner.queries.map(query => query.sql.replace(/\s+/g, ' ').trim());
}

test('valid neighborhood parent persists the advisory recommendation and releases its savepoint', async () => {
  const runner = new FakeRunner(true);
  const { controlConfig, executedConfig } = configs();

  const result = await evaluateShadowRetrievalRecommendation({
    opportunityKey: 'opp_valid_parent',
    queryRunId: '00000000-0000-0000-0000-000000000001',
    neighborhoodKey: 'neighborhood:valid',
    controlConfig,
    executedConfig,
    clientOverride: runner
  });

  assert.equal(result.evidence.shadowPersistenceStatus, 'PERSISTED');
  assert.equal(result.evidence.neighborhoodKeyValidated, true);
  assert.equal(sqls(runner).filter(sql => sql.toLowerCase().startsWith('insert into retrieval_policy_shadow_recommendations')).length, 1);
  assert.ok(sqls(runner).includes('RELEASE SAVEPOINT retrieval_policy_shadow_recommendation'));
});

test('missing neighborhood parent skips shadow persistence without creating a parent and leaves the caller usable', async () => {
  const runner = new FakeRunner(false);
  const { controlConfig, executedConfig } = configs();

  const result = await evaluateShadowRetrievalRecommendation({
    opportunityKey: 'opp_missing_parent',
    neighborhoodKey: 'neighborhood:missing',
    controlConfig,
    executedConfig,
    clientOverride: runner
  });
  const followUp = await runner.query('SELECT 42');

  assert.equal(result.evidence.shadowPersistenceStatus, 'SKIPPED_NEIGHBORHOOD_PARENT_MISSING');
  assert.equal(result.evidence.neighborhoodKeyValidated, false);
  assert.equal((followUp.rows[0] as { answer: number }).answer, 42);
  assert.equal(sqls(runner).some(sql => sql.toLowerCase().includes('insert into retrieval_policy_shadow_recommendations')), false);
  assert.equal(sqls(runner).some(sql => sql.toLowerCase().includes('insert into discovery_neighborhoods')), false);
  assert.ok(sqls(runner).includes('RELEASE SAVEPOINT retrieval_policy_shadow_recommendation'));
});

test('shadow persistence failure rolls back to its savepoint and leaves the caller transaction usable', async () => {
  const runner = new FakeRunner(true, true);
  const { controlConfig, executedConfig } = configs();

  const result = await evaluateShadowRetrievalRecommendation({
    opportunityKey: 'opp_failed_shadow',
    neighborhoodKey: 'neighborhood:fk-failure',
    controlConfig,
    executedConfig,
    clientOverride: runner
  });
  const followUp = await runner.query('SELECT 42');
  const statements = sqls(runner);

  assert.equal(result.evidence.shadowPersistenceStatus, 'SKIPPED_ISOLATED_FAILURE');
  assert.equal(result.evidence.shadowFailureClass, 'Error');
  assert.equal((followUp.rows[0] as { answer: number }).answer, 42);
  assert.ok(statements.includes('ROLLBACK TO SAVEPOINT retrieval_policy_shadow_recommendation'));
  assert.ok(statements.includes('RELEASE SAVEPOINT retrieval_policy_shadow_recommendation'));
});

test('repeated shadow failures cannot poison a surrounding scheduler batch', async () => {
  const runner = new FakeRunner(true, true);
  const { controlConfig, executedConfig } = configs();

  for (const opportunityKey of ['opp_batch_1', 'opp_batch_2', 'opp_batch_3']) {
    const result = await evaluateShadowRetrievalRecommendation({
      opportunityKey,
      neighborhoodKey: `neighborhood:${opportunityKey}`,
      controlConfig,
      executedConfig,
      clientOverride: runner
    });
    assert.equal(result.evidence.shadowPersistenceStatus, 'SKIPPED_ISOLATED_FAILURE');
    const followUp = await runner.query('SELECT 42');
    assert.equal((followUp.rows[0] as { answer: number }).answer, 42);
  }

  assert.equal(sqls(runner).filter(sql => sql.startsWith('ROLLBACK TO SAVEPOINT retrieval_policy_shadow_recommendation')).length, 3);
});

test('PostgreSQL savepoint semantics preserve the caller transaction when a shadow insert fails', { skip: !process.env.PHASE4_POSTGRES_URL }, async () => {
  const pool = new Pool({ connectionString: process.env.PHASE4_POSTGRES_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE shadow_probe(id integer primary key)');
    await client.query('SAVEPOINT retrieval_policy_shadow_probe');
    await assert.rejects(() => client.query('INSERT INTO shadow_probe(id) VALUES($1)', [1]));
    await client.query('ROLLBACK TO SAVEPOINT retrieval_policy_shadow_probe');
    await client.query('RELEASE SAVEPOINT retrieval_policy_shadow_probe');
    const result = await client.query('SELECT 42 AS answer');
    assert.equal(result.rows[0].answer, 42);
    await client.query('ROLLBACK');
  } finally {
    client.release();
    await pool.end();
  }
});
