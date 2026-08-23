import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dbSource = fs.readFileSync(path.join(process.cwd(), 'server/db.ts'), 'utf8');
const queueSource = fs.readFileSync(path.join(process.cwd(), 'server/queueManager.ts'), 'utf8');
const migrationSource = fs.readFileSync(path.join(process.cwd(), 'server/db/migrations/117_query_run_accounting_attribution.sql'), 'utf8');

test('completed query runs use a durable exactly-once accounting marker', () => {
  assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS query_run_accounting_attributions/);
  assert.match(migrationSource, /query_run_id UUID PRIMARY KEY/);
  assert.match(dbSource, /INSERT INTO query_run_accounting_attributions\(query_run_id,query_id,attribution_version/);
  assert.match(dbSource, /ON CONFLICT\(query_run_id\) DO NOTHING RETURNING query_run_id/);
  assert.match(dbSource, /UPDATE query_library SET times_executed=times_executed\+1/);
});

test('successful accounting keeps query-run, execution-log, and learned-term linkage', () => {
  assert.match(migrationSource, /ALTER TABLE query_execution_logs[\s\S]*ADD COLUMN IF NOT EXISTS query_run_id UUID/);
  assert.match(migrationSource, /idx_query_execution_logs_query_run/);
  assert.match(dbSource, /attributeTerminologyPerformance\(rowToQuery\(row\), attributionMetrics/);
  assert.match(dbSource, /INSERT INTO query_execution_logs\(query_run_id,query_id,query,country/);
  assert.match(dbSource, /ON CONFLICT\(query_run_id\) WHERE query_run_id IS NOT NULL DO NOTHING/);
});

test('queue evaluation delegates persistence to completed-run accounting', () => {
  assert.match(queueSource, /evaluateQueryPerformance\(queryRecord, finalMetrics, \{ retrievalLane, searchOrdering, quotaConsumed, persist: false \}\)/);
  assert.match(queueSource, /performanceScore: performance\.performanceScore/);
  assert.match(queueSource, /newCollection: performance\.newCollection/);
});

test('provider-capacity failures persist stable diagnostic metadata without changing retry control', () => {
  assert.match(dbSource, /classifyProviderCapacityFailure\(error\)/);
  assert.match(dbSource, /providerCapacityReason/);
  assert.match(dbSource, /status='RETRYING'/);
  assert.match(dbSource, /status='FAILED'/);
});

test('reservation predicate and PART K recovery remain present and unchanged in the scheduling seam', () => {
  assert.match(dbSource, /reconcileQueryRunJobLifecycleForQuery\(client, candidate\.query\.id\)/);
  assert.match(dbSource, /AND \(reserved_until IS NULL OR reserved_until <= now\(\)\)/);
  assert.match(dbSource, /AND NOT EXISTS \(SELECT 1 FROM query_runs qr WHERE qr\.query_id=query_library\.id AND qr\.status IN \('SCHEDULED','RUNNING','RETRYING'\)\)/);
});
