import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=process.cwd();
const read=(p:string)=>fs.readFileSync(path.join(root,p),'utf8');

test('authoritative review migration blocks unbacked NEEDS_REVIEW projections',()=>{
  const sql=read('server/db/migrations/094_authoritative_review_projection.sql');
  assert.match(sql,/channel_reviews r/);
  assert.match(sql,/r\.state = 'PENDING'/);
  assert.match(sql,/NEW\.trading_status := 'UNCERTAIN'/);
  assert.match(sql,/OLD\.scan_status = 'ENRICHING'.*THEN 'FAILED'/s);
  assert.match(sql,/BEFORE INSERT OR UPDATE ON channels/);
});

test('eligible review materializer requires serving authority and writes durable review before channel projection',()=>{
  const source=read('server/release5/reviewMaterializer.ts');
  assert.match(source,/serving_authority!==true/);
  const reviewWrite=source.indexOf('INSERT INTO channel_reviews');
  const channelWrite=source.indexOf("UPDATE channels SET trading_status='NEEDS_REVIEW'");
  assert.ok(reviewWrite>=0&&channelWrite>reviewWrite,'durable review must exist before NEEDS_REVIEW channel projection');
});

test('review decision store persists reason-family serving decisions even when legacy rollout mode is OFF',()=>{
  const source=read('server/reviewEligibility/store.ts');
  assert.match(source,/serving_authority\) VALUES\([\s\S]*true\)/);
  assert.match(source,/reasonFamily:evaluation\.reasonFamily/);
  assert.doesNotMatch(source,/if\(configured==='OFF'\)return/);
});
