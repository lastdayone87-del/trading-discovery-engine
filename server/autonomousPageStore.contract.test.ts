import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = readFileSync(fileURLToPath(new URL('./autonomousPageStore.ts', import.meta.url)), 'utf8');

test('page-funnel outcome event does not reuse the text subject parameter for UUID query_run_id', () => {
  assert.match(
    source,
    /VALUES\(\$1,'QUERY_PAGE',\$2,'PAGE_FUNNEL_RECORDED',1,\$3,\$4,\$9,\$5,\$6,\$7,'PROVISIONAL'/
  );
  assert.match(
    source,
    /JSON\.stringify\(\{\.\.\.p\.pageMetrics,quotaUsed:p\.quotaUnits,pageNumber:p\.pageNumber\}\),p\.queryRunId\]/
  );
  assert.doesNotMatch(
    source,
    /VALUES\(\$1,'QUERY_PAGE',\$2,'PAGE_FUNNEL_RECORDED',1,\$3,\$4,\$2,/
  );
});
