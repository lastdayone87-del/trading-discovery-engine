import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(process.cwd(), 'server/db.ts'), 'utf8');

test('frontier completion casts quota columns to their distinct database types', () => {
  assert.match(
    source,
    /SET quota_consumed=\$2::int,provider_consumed_amount=\$2::bigint/
  );
});

test('frontier completion retains the committed query-run guard', () => {
  assert.match(
    source,
    /WHERE query_run_id=\$1 AND decision_status='COMMITTED' AND provider_key=\(SELECT provider_key FROM query_runs WHERE id=\$1\)/
  );
});

test('frontier completion does not change provider or accounting ownership', () => {
  assert.match(source, /UPDATE quota_reservations SET status='CONSUMED'/);
  assert.match(source, /query_run_accounting_attributions/);
  assert.match(source, /query_execution_logs/);
});
