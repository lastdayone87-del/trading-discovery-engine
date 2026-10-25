import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProductionDiagnosticInput } from './classificationDiagnostics';

test('diagnostic checksum excludes job/run attribution but keeps classification evidence', () => {
  const first = normalizeProductionDiagnosticInput({
    channel_name: '  Example Creator  ',
    description: 'Trading education',
    external_links: ['https://b.example', 'https://a.example'],
    job_id: 'enrich-job-1',
    run_id: 'query-run-1',
  });
  const replay = normalizeProductionDiagnosticInput({
    channel_name: 'Example Creator',
    description: 'Trading education',
    external_links: ['https://a.example', 'https://b.example'],
    job_id: 'enrich-job-2',
    run_id: 'query-run-2',
  });
  assert.equal(first.input_checksum, replay.input_checksum);
  assert.equal(first.job_id, undefined);
  assert.equal(first.run_id, undefined);

  const changedEvidence = normalizeProductionDiagnosticInput({
    channel_name: 'Example Creator',
    description: 'Unrelated sports commentary',
    external_links: ['https://a.example', 'https://b.example'],
    job_id: 'enrich-job-1',
    run_id: 'query-run-1',
  });
  assert.notEqual(first.input_checksum, changedEvidence.input_checksum);
});
