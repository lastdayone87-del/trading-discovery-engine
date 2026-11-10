import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./reviewEvidence.ts', import.meta.url), 'utf8');

test('review evidence resolves the diagnostic through the eligibility decision first', () => {
  assert.match(source, /classification_diagnostic_id/);
  assert.match(source, /WHERE id=\$1 AND channel_id=\$2/);
  assert.match(source, /ORDER BY created_at DESC,id DESC\s+LIMIT 1/);
});

test('review evidence selects explicit diagnostic columns and bounded evidence reads', () => {
  assert.match(source, /normalized_input/);
  assert.match(source, /evidence_items/);
  assert.match(source, /staged_report/);
  assert.match(source, /provider_execution/);
  assert.match(source, /Math\.min\(100,\s*Math\.max\(1,\s*options\.documentLimit\s*\|\|\s*50\)\)/);
  assert.match(source, /Math\.min\(200,\s*Math\.max\(1,\s*options\.assertionLimit\s*\|\|\s*100\)\)/);
  assert.match(source, /Math\.min\(50,\s*Math\.max\(1,\s*options\.coverageLimit\s*\|\|\s*20\)\)/);
  assert.doesNotMatch(source, /SELECT\s+\*\s+FROM production_classification_diagnostics/i);
});
