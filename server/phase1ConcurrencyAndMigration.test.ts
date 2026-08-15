import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

test('rolling deployment trigger converts unbacked NEEDS_REVIEW to ENRICHMENT_PENDING', () => {
  const sql = read('server/db/migrations/094_authoritative_review_projection.sql');
  assert.match(sql, /NEW\.trading_status := 'UNCERTAIN'/);
  assert.match(sql, /NEW\.scan_status := 'ENRICHMENT_PENDING'/);
});

test('store enforces monotonic evidence timestamp ordering for projections', () => {
  const storeSource = read('server/reviewEligibility/store.ts');
  assert.match(storeSource, /WHERE excluded\.decided_at>=review_eligibility_projection\.decided_at/);
  assert.match(storeSource, /decidedAt/);
});

test('review materializer prevents older machine eligibility from reopening human-resolved reviews', () => {
  const matSource = read('server/release5/reviewMaterializer.ts');
  assert.match(matSource, /SUPERSEDED_BY_HUMAN_RESOLUTION/);
  assert.match(matSource, /new Date\(eligibility\.rows\[0\]\.decided_at\)\.getTime\(\)<=new Date\(humanDecidedAt\)\.getTime\(\)/);
});

test('investigation reconciliation converts linked NEEDS_REVIEW investigations on machine ownership resume', () => {
  const storeSource = read('server/reviewEligibility/store.ts');
  assert.match(storeSource, /subject_type='CHANNEL' AND subject_id=\$1 AND state='NEEDS_REVIEW'/);
  assert.match(storeSource, /INVESTIGATION_RECOVERED/);
});
