import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const resultsTable=readFileSync(new URL('../src/components/ResultsTable.tsx',import.meta.url),'utf8');

test('recoverable Discord validation is presented as retry required, not queued retry',()=>{
  assert.match(resultsTable,/Validation retry required/);
  assert.doesNotMatch(resultsTable,/Validation retry pending/);
});
