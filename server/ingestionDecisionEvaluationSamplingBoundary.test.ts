import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const ingestion = readFileSync(new URL('./ingestionPipeline.ts', import.meta.url), 'utf8');

test('ingestion uses the normalized decision-evaluation sampling policy', () => {
  assert.match(
    ingestion,
    /buildDecisionEvaluationSamplingPolicy\(process\.env\.DECISION_EVALUATION_SAMPLING_SALT\)/
  );
  assert.match(ingestion, /policy:\s*samplingPolicy/);
  assert.doesNotMatch(
    ingestion,
    /salt:\s*process\.env\.DECISION_EVALUATION_SAMPLING_SALT/
  );
});

test('missing sampling policy fails closed before creating an assignment', () => {
  assert.match(ingestion, /if \(samplingPolicy\) \{/);
  assert.match(ingestion, /observeRetrievalAssignmentReliably\(/);
});
