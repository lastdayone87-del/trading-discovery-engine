import { getDb } from '../server/db';
import { decideReview } from '../server/reviewStore';
import { REVIEW_REASON_CATALOG, REVIEW_REASON_CATALOG_VERSION } from '../server/reviewReasons';

const channelSelector = String(process.env.REVIEW_CHANNEL || '').trim();
const action = String(process.env.REVIEW_ACTION || '').trim().toUpperCase();
const reasonCode = String(process.env.REVIEW_REASON_CODE || '').trim();
const notes = String(process.env.REVIEW_NOTES || '').trim();
const actor = String(process.env.REVIEW_ACTOR || 'github-actions').trim();
const confirmation = String(process.env.REVIEW_CONFIRMATION || '').trim();

if (!channelSelector) throw new Error('REVIEW_CHANNEL is required.');
if (action !== 'APPROVE' && action !== 'REJECT') throw new Error('REVIEW_ACTION must be APPROVE or REJECT.');
if (confirmation !== 'COMMIT_HUMAN_REVIEW_DECISION') throw new Error('Explicit confirmation COMMIT_HUMAN_REVIEW_DECISION is required.');
if (!actor) throw new Error('REVIEW_ACTOR is required.');

const catalog = REVIEW_REASON_CATALOG[action];
if (!catalog.some(option => option.code === reasonCode)) throw new Error(`REVIEW_REASON_CODE is not valid for ${action}.`);
if (reasonCode === 'OTHER') throw new Error('OTHER is intentionally unsupported by the fallback command; use a governed explicit reason code.');

const db = await getDb();
const lookup = await db.query(`
  SELECT r.channel_id,r.review_version,r.state,c.channel_name
  FROM channel_reviews r JOIN channels c USING(channel_id)
  WHERE r.state='PENDING'
    AND (r.channel_id=$1 OR lower(c.channel_name)=lower($1))
  ORDER BY r.pending_since ASC,r.channel_id
`, [channelSelector]);

if (!lookup.rowCount) throw new Error('No pending review matched REVIEW_CHANNEL.');
if (lookup.rowCount !== 1) throw new Error('REVIEW_CHANNEL matched more than one pending review; use the exact channel_id.');

const row = lookup.rows[0];
const idempotencyKey = `governed-review:${row.channel_id}:${row.review_version}:${action}:${reasonCode}`;
const result = await decideReview({
  channelId: String(row.channel_id),
  action,
  expectedVersion: Number(row.review_version),
  reviewer: actor,
  reviewReasonCode: reasonCode,
  reviewReasonVersion: REVIEW_REASON_CATALOG_VERSION,
  notes: notes || undefined,
  idempotencyKey
});

const decisionId = String(result.decision.id);
const deadline = Date.now() + 30000;
let groundTruth: any = null;
let outbox: any = null;
while (Date.now() < deadline) {
  const [labelResult, outboxResult] = await Promise.all([
    db.query(`SELECT id,label,provenance,labeled_at FROM evaluation_ground_truth_labels WHERE review_decision_id=$1 ORDER BY labeled_at DESC LIMIT 1`, [decisionId]),
    db.query(`SELECT id,status,attempts,last_error,completed_at FROM phase_b_observation_outbox WHERE observation_key=$1 ORDER BY created_at DESC LIMIT 1`, [`phase-b:ground-truth:${decisionId}`])
  ]);
  groundTruth = labelResult.rows[0] || null;
  outbox = outboxResult.rows[0] || null;
  if (groundTruth && outbox?.status === 'COMPLETED') break;
  await new Promise(resolve => setTimeout(resolve, 500));
}

const report = {
  channelId: row.channel_id,
  channelName: row.channel_name,
  action,
  reasonCode,
  reasonCatalogVersion: REVIEW_REASON_CATALOG_VERSION,
  decisionId,
  review: result.review,
  channel: result.channel,
  idempotent: result.idempotent,
  groundTruth: groundTruth ? { id: groundTruth.id, label: groundTruth.label, provenance: groundTruth.provenance, labeledAt: groundTruth.labeled_at } : null,
  outbox: outbox ? { id: outbox.id, status: outbox.status, attempts: outbox.attempts, lastError: outbox.last_error, completedAt: outbox.completed_at } : null,
  independentLabelChainComplete: Boolean(groundTruth && outbox?.status === 'COMPLETED')
};

console.log(JSON.stringify(report, null, 2));
if (!report.independentLabelChainComplete) process.exitCode = 2;
