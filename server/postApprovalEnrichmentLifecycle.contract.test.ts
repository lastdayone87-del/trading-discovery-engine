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

test('existing community retry terminal projection remains a separate lifecycle path', () => {
  assert.match(queueManager, /if \(job\.type === 'RETRY_COMMUNITY_ACQUISITION' && terminal\)/);
  assert.match(queueManager, /channel\.discord_validation_status='RETRY_PENDING'/);
});
