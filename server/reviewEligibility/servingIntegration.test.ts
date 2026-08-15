import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=process.cwd();
const read=(p:string)=>fs.readFileSync(path.join(root,p),'utf8');

test('authoritative review migration blocks unbacked NEEDS_REVIEW projections',()=>{
  const sql=read('server/db/migrations/094_authoritative_review_projection.sql');
  assert.match(sql,/DROP CONSTRAINT IF EXISTS review_eligibility_decisions_serving_authority_check/);
  assert.match(sql,/channel_reviews r/);
  assert.match(sql,/r\.state = 'PENDING'/);
  assert.match(sql,/NEW\.trading_status := 'UNCERTAIN'/);
  assert.match(sql,/OLD\.scan_status = 'ENRICHING'.*THEN 'FAILED'/s);
  assert.match(sql,/BEFORE INSERT OR UPDATE ON channels/);
});

test('eligible review materializer requires serving authority and writes durable review before new channel review projection',()=>{
  const source=read('server/release5/reviewMaterializer.ts');
  assert.match(source,/serving_authority!==true/);
  assert.match(source,/INSERT INTO channel_reviews[\s\S]*UPDATE channels SET trading_status='NEEDS_REVIEW'/);
});

test('review decision store persists reason-family serving decisions and retries idempotent eligible materialization',()=>{
  const source=read('server/reviewEligibility/store.ts');
  assert.match(source,/serving_authority\) VALUES\([\s\S]*true\)/);
  assert.match(source,/reasonFamily:evaluation\.reasonFamily/);
  assert.doesNotMatch(source,/if\(configured==='OFF'\)return/);
  assert.match(source,/idempotent review materialization retry failed/);
});
