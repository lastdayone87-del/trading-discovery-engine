import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const queueManager = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');

test('post-approval operational projection is terminal-only and preserves review authority', () => {
  assert.match(queueManager, /const disposition=await failJob\(job\.id, err\);[\s\S]*const terminal=disposition==='FAILED';/);
  assert.match(queueManager, /if \(job\.type === 'POST_APPROVAL_ENRICH' && terminal\)/);
  assert.match(queueManager, /resolveTerminalEnrichmentFailure\(channel, terminal\)/);
  assert.doesNotMatch(queueManager, /POST_APPROVAL_ENRICH[\s\S]{0,1200}recordAdmissionShadow/);
});

test('post-approval failures preserve provider taxonomy instead of erasing it', () => {
  // A plain `throw new Error(result.message)` would erase retryable/errorClass/
  // retryAt, turning quota/transient deferrals into attempt-consuming failures
  // and stranding approved enrichment. The worker must carry the taxonomy
  // forward so failJob can defer attempt-free with the provider schedule.
  assert.match(queueManager, /triggerManualRecheck\(channelId, true, true\)/);
  assert.match(queueManager, /errorClass:typedTransient\?result\.errorClass:undefined/);
  assert.match(queueManager, /retryAt:typedTransient\?result\.retryAt:undefined/);
  assert.match(queueManager, /retryAfterMs:typedTransient\?result\.retryAfterMs:undefined/);
  assert.doesNotMatch(queueManager, /if\(!result\.success\) throw new Error\(result\.message\);/);
});

test('existing community retry terminal projection remains a separate lifecycle path', () => {
  assert.match(queueManager, /if \(job\.type === 'RETRY_COMMUNITY_ACQUISITION' && terminal\)/);
  assert.match(queueManager, /projectTerminalCommunityRetryFailure\(channel,job\.attempts/);
});
