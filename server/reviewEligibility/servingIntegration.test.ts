import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=process.cwd();
const read=(p:string)=>fs.readFileSync(path.join(root,p),'utf8');

test('authoritative review migration blocks unbacked NEEDS_REVIEW projections and retires legacy queue sync',()=>{
  const sql=read('server/db/migrations/094_authoritative_review_projection.sql');
  assert.match(sql,/DROP CONSTRAINT IF EXISTS review_eligibility_decisions_serving_authority_check/);
  assert.match(sql,/DROP TRIGGER IF EXISTS channels_sync_review_queue/);
  assert.match(sql,/state='SUPERSEDED'/);
  assert.match(sql,/review-eligibility-v2-serving-1/);
  assert.match(sql,/eligibilityDecisionId/);
  assert.match(sql,/NEW\.trading_status := 'UNCERTAIN'/);
  assert.match(sql,/NEW\.scan_status := 'ENRICHMENT_PENDING'/);
  assert.match(sql,/scan_status=CASE WHEN c\.scan_status='NEEDS_REVIEW' THEN 'ENRICHMENT_PENDING'/);
  assert.doesNotMatch(sql,/scan_status=CASE WHEN c\.scan_status='NEEDS_REVIEW' THEN 'COMPLETED'/);
  assert.match(sql,/BEFORE INSERT OR UPDATE ON channels/);
});

test('post-094 repair requeues only stranded legacy review rows while preserving authoritative NOT_ELIGIBLE completion',()=>{
  const sql=read('server/db/migrations/095_requeue_legacy_review_cleanup.sql');
  assert.match(sql,/c\.trading_status='UNCERTAIN'/);
  assert.match(sql,/c\.scan_status='COMPLETED'/);
  assert.match(sql,/r\.state='SUPERSEDED'/);
  assert.match(sql,/SET scan_status='ENRICHMENT_PENDING'/);
  assert.match(sql,/p\.status='NOT_ELIGIBLE'/);
});

test('eligible review materializer serializes against current projection, checks human resolution timestamp, and reopens eligible reviews',()=>{
  const source=read('server/release5/reviewMaterializer.ts');
  assert.match(source,/review_eligibility_projection WHERE channel_id=\$1 FOR UPDATE/);
  assert.match(source,/projection\.rows\[0\]\.decision_id!==input\.eligibilityDecisionId/);
  assert.match(source,/serving_authority!==true/);
  assert.match(source,/prior\?\.state==='PENDING'&&priorDecisionId===input\.eligibilityDecisionId/);
  assert.match(source,/SUPERSEDED_BY_HUMAN_RESOLUTION/);
  assert.match(source,/nextVersion=prior\?Number\(prior\.review_version\)\+1:1/);
  assert.match(source,/INSERT INTO channel_reviews[\s\S]*UPDATE channels SET trading_status='NEEDS_REVIEW'/);
});

test('review decision store uses monotonic evidence timestamps and reconciles linked investigations in same transaction',()=>{
  const source=read('server/reviewEligibility/store.ts');
  assert.match(source,/WHERE excluded\.decided_at>=review_eligibility_projection\.decided_at/);
  assert.match(source,/reasonFamily:evaluation\.reasonFamily/);
  assert.match(source,/INVESTIGATION_RECOVERED/);
  assert.match(source,/materializeEligibleReviewInTransaction\(client/);
  const materialize=source.indexOf('materializeEligibleReviewInTransaction(client');
  const commit=source.indexOf("client.query('COMMIT')",materialize);
  assert.ok(materialize>=0&&commit>materialize,'eligible materialization must complete before transaction commit');
});


test('machine-owned authoritative projections supersede stale pending review debt and reconcile linked investigations',()=>{const source=read('server/reviewEligibility/store.ts');assert.match(source,/reconcileMachineOwnedReview/);assert.match(source,/state='SUPERSEDED'/);assert.match(source,/subject_type='CHANNEL' AND subject_id=\$1 AND state='NEEDS_REVIEW'/);});
test('production persistence failures propagate and missing channels never synthesize review',()=>{const ingestion=read('server/ingestionPipeline.ts'),queue=read('server/queueManager.ts');assert.doesNotMatch(ingestion,/authoritative write failed/);assert.doesNotMatch(queue,/channel\?\.trading_status\|\|'NEEDS_REVIEW'/);assert.match(queue,/channel\?\.trading_status\|\|'POLICY_REJECTED'/);});
