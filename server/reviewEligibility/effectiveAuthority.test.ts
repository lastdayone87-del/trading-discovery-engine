import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');

test('review inspection exposes configured mode and effective authoritative serving separately', () => {
  assert.match(source, /configuredMode=String\(await getAppSetting\('review_eligibility_v2_mode','OFF'\)\)\.toUpperCase\(\)/);
  assert.match(source, /effectiveAuthorityModel:'AUTHORITATIVE_REVIEW_ELIGIBILITY_TRANSACTION'/);
  assert.match(source, /effectiveServingAuthority:true/);
  assert.match(source, /effectiveCreatesReviewRows:true/);
  assert.match(source, /modeControlsServingAuthority:false/);
});

test('review inspection remains aggregate-only and does not mutate production state', () => {
  const inspection = source.slice(source.indexOf('export async function inspectReviewEligibility'));
  assert.doesNotMatch(inspection, /\b(INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)\b/i);
  assert.match(inspection, /LIMIT \$1/);
  assert.match(inspection, /Math\.min\(500,Math\.max\(1,limit\)\)/);
});
