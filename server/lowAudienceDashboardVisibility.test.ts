import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('default channel listing excludes low-audience skips unless explicitly requested',()=>{
  const db=fs.readFileSync(new URL('./db.ts',import.meta.url),'utf8');
  assert.match(db,/const explicitlyViewingLowAudience=args\.scanStatus==='SKIPPED_LOW_AUDIENCE'/);
  assert.match(db,/!explicitlyViewingLowAudience\)clauses\.push\(`scan_status <> 'SKIPPED_LOW_AUDIENCE'`\)/);
  assert.match(db,/add\('scan_status',args\.scanStatus\)/);
});

test('channel table exposes an explicit low-audience filter and defensively hides it by default',()=>{
  const table=fs.readFileSync(new URL('../src/components/ResultsTable.tsx',import.meta.url),'utf8');
  assert.match(table,/value="SKIPPED_LOW_AUDIENCE">LOW AUDIENCE \(Skipped &lt;30\)/);
  assert.match(table,/selectedScanStatus === 'SKIPPED_LOW_AUDIENCE'/);
  assert.match(table,/c\.scan_status !== 'SKIPPED_LOW_AUDIENCE'/);
});
