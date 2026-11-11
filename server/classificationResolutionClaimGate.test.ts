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
