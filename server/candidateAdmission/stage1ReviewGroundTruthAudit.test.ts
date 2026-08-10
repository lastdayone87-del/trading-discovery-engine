import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeStage1ReviewGroundTruthAudit } from './stage1ReviewGroundTruthAudit';

test('summarizes exact recoverability without fabricating lineage', () => {
  const rows:any[] = [
    { decision:'APPROVE', label_id:null, outbox_id:null, outbox_status:null, diagnostic_id:'d1', assignment_id:'a1', inclusion_basis_points:5000, focus_snapshot_id:'f1', coverage_snapshot_id:'c1' },
    { decision:'REJECT', label_id:null, outbox_id:'o1', outbox_status:'PENDING', diagnostic_id:'d2', assignment_id:null, inclusion_basis_points:null, focus_snapshot_id:'f2', coverage_snapshot_id:'c2' },
    { decision:'REJECT', label_id:'l3', outbox_id:'o3', outbox_status:'COMPLETED', diagnostic_id:'d3', assignment_id:'a3', inclusion_basis_points:5000, focus_snapshot_id:'f3', coverage_snapshot_id:'c3' }
  ];
  const summary = summarizeStage1ReviewGroundTruthAudit(rows);
  assert.equal(summary.reviewDecisions,3);
  assert.equal(summary.approve,1);
  assert.equal(summary.reject,2);
  assert.equal(summary.linkedGroundTruthLabels,1);
  assert.equal(summary.missingGroundTruthLabels,2);
  assert.equal(summary.outboxCaptured,2);
  assert.equal(summary.outboxPending,1);
  assert.equal(summary.exactLineageRecoverableAfterLabelReconciliation,2);
  assert.equal(summary.exactLineageRecoverableTrading,1);
  assert.equal(summary.exactLineageRecoverableNonTrading,1);
  assert.equal(summary.exclusions.RETRIEVAL_ASSIGNMENT_MISSING,1);
});
