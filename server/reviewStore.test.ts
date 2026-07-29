import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReviewTransition, ReviewConflictError } from './reviewStore';

test('pending review can be approved or rejected',()=>{
  assert.equal(resolveReviewTransition('PENDING','APPROVE'),'APPROVED');
  assert.equal(resolveReviewTransition('PENDING','REJECT'),'REJECTED');
});
test('only a rejected decision can be force rescanned',()=>{
  assert.equal(resolveReviewTransition('REJECTED','FORCE_RESCAN'),'PENDING');
  assert.throws(()=>resolveReviewTransition('APPROVED','FORCE_RESCAN'),ReviewConflictError);
});
test('terminal decisions cannot be overwritten',()=>{
  assert.throws(()=>resolveReviewTransition('APPROVED','REJECT'),ReviewConflictError);
  assert.throws(()=>resolveReviewTransition('REJECTED','APPROVE'),ReviewConflictError);
});
