import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { semanticCooldownProbeAllowed, SEMANTIC_COOLDOWN_ENRICH_PROBE_INTERVAL_MS } from './queueManager';

test('semantic cooldown still allows a bounded evidence-acquisition probe', () => {
  const now = 1_000_000;
  assert.equal(semanticCooldownProbeAllowed(0, now), true);
  assert.equal(semanticCooldownProbeAllowed(now - 1_000, now), false);
  assert.equal(semanticCooldownProbeAllowed(now - SEMANTIC_COOLDOWN_ENRICH_PROBE_INTERVAL_MS, now), true);
  assert.equal(semanticCooldownProbeAllowed(now - 1_000, now, 1_000), true);
});

test('classification remains gated while enrichment gets only the probe', () => {
  const source = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(source, /enrichmentFullyClaimable \|\| enrichmentProbe/);
  assert.match(source, /if \(enrichmentFullyClaimable && \(!claimableOverride/);
  assert.match(source, /stage-1\/2 evidence is persisted before the semantic attempt/);
});

test('probe-only claims are restricted to unhydrated stage-1/2 jobs', () => {
  const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(dbCore, /enrichProbeOnly=false/);
  assert.match(dbCore, /NOT \$5::boolean OR type <> 'ENRICH_CHANNEL'/);
  assert.match(queue, /enrichProbeOnly = enrichmentProbe && !enrichmentFullyClaimable/);
  assert.match(queue, /RESOLUTION_CLAIM_BUDGET_GUARDS\], enrichProbeOnly/);
});
