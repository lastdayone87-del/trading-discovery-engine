import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

const expectedCommitSql = /query_run_id\s*=\s*\$2::uuid[\s\S]*WHERE decision_id\s*=\s*\$1::text[\s\S]*query_run_id\s*IS NULL OR query_run_id\s*=\s*\$2::uuid/;

test('scheduler frontier commit pins decision text and query-run UUID parameter types', () => {
  assert.match(read('server/db.ts'), expectedCommitSql);
});

test('allocator frontier commit pins decision text and query-run UUID parameter types', () => {
  assert.match(read('server/discoveryFrontierAllocator.ts'), expectedCommitSql);
});

test('frontier commit remains a guarded RESERVED-to-COMMITTED transition', () => {
  const db = read('server/db.ts');
  const allocator = read('server/discoveryFrontierAllocator.ts');
  for (const source of [db, allocator]) {
    assert.match(source, /decision_status\s*=\s*'COMMITTED'/);
    assert.match(source, /allocation_origin\s*=\s*'FRONTIER_CANARY'/);
    assert.match(source, /decision_status\s*=\s*'RESERVED'/);
  }
});
