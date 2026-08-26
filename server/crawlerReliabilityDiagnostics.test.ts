import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync('server/dbCore.ts', 'utf8');

test('crawler reliability exposes aggregate outcome and failure-class breakdown', () => {
  assert.match(source, /outcomeBreakdown:breakdown\.rows/);
  assert.match(source, /failure_class/);
  assert.match(source, /provenance->>'required'/);
  assert.match(source, /GROUP BY surface,required,outcome,retryable,failure_class/);
});

test('crawler reliability diagnostic does not select raw acquisition fields', () => {
  const start = source.indexOf('export async function getCrawlerReliabilityMetrics');
  const end = source.indexOf('export async function appendValidationRun', start);
  const functionSource = source.slice(start, end);
  assert.doesNotMatch(functionSource, /requested_url|final_url|detail|channel_id/);
});
