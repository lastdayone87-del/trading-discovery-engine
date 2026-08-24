import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = fs.readFileSync(path.join(process.cwd(), 'server', 'dbCore.ts'), 'utf8');

test('completeQueryRun binds frontier quota columns with distinct typed parameters', () => {
  const match = source.match(/UPDATE frontier_allocation_decisions[\s\S]{0,420}?WHERE query_run_id=\$1[\s\S]{0,240}?metrics\.quotaUsed,metrics\.quotaUsed/);
  assert.ok(match, 'completeQueryRun must update frontier consumption with both typed values');
  assert.match(match[0], /quota_consumed=\$2::int/);
  assert.match(match[0], /provider_consumed_amount=\$3::bigint/);
  assert.doesNotMatch(match[0], /quota_consumed=\$2::int,provider_consumed_amount=\$2::bigint/);
});
