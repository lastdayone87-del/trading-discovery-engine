import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const pipeline = readFileSync(new URL('../ingestionPipeline.ts', import.meta.url), 'utf8');

test('pipeline uses the deterministic routing decision for review and non-terminal negative guards', () => {
  assert.match(pipeline, /resolveClassificationRoutingMode/);
  assert.match(pipeline, /deterministicReview\s*=\s*routingActive\s*&&\s*classificationRouting\?\.humanReview/);
  assert.match(pipeline, /NON_TERMINAL_NEGATIVE_EVIDENCE_REQUIRES_REVIEW/);
  assert.match(pipeline, /plausibleTradingHypothesis:independentHypothesis\|\|deterministicReview/);
});

test('routing remains default-on with an explicit LEGACY rollback', async () => {
  const routing = await import('./deterministicFirst');
  assert.equal(routing.resolveClassificationRoutingMode({} as NodeJS.ProcessEnv), 'ACTIVE');
  assert.equal(
    routing.resolveClassificationRoutingMode({ DETERMINISTIC_CLASSIFICATION_ROUTING: 'LEGACY' } as NodeJS.ProcessEnv),
    'LEGACY',
  );
});
