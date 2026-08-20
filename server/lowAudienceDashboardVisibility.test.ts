import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('master channel listing includes low-audience rows unless explicitly filtered',()=>{
  const db=fs.readFileSync(new URL('./db.ts',import.meta.url),'utf8');
  assert.match(db,/const clauses=\[args\.diagnosticsOnly[\s\S]+:'TRUE'\]/);
  assert.doesNotMatch(db,/explicitlyViewingLowAudience/);
  assert.doesNotMatch(db,/subscriber_count::integer < 30/);
  assert.match(db,/add\('scan_status',args\.scanStatus\)/);
});

test('channel table exposes low audience as an explicit filter without silently hiding it',()=>{
  const table=fs.readFileSync(new URL('../src/components/ResultsTable.tsx',import.meta.url),'utf8');
  assert.match(table,/value="SKIPPED_LOW_AUDIENCE">LOW AUDIENCE \(Skipped &lt;30\)/);
  assert.doesNotMatch(table,/matchesLowAudienceVisibility/);
  assert.doesNotMatch(table,/c\.scan_status !== 'SKIPPED_LOW_AUDIENCE'/);
});
