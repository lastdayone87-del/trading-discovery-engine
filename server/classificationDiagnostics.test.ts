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
  assert.equal(first.input_checksum_version, 'canonical-json-v1');
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

test('audience counters do not change the evidence checksum', () => {
  const base = {
    channel_name: 'Example Creator',
    description: 'Trading education',
  };
  const first = normalizeProductionDiagnosticInput({ ...base, subscriber_count: 12, video_count: 3 });
  const replayed = normalizeProductionDiagnosticInput({ ...base, subscriber_count: 900_000, video_count: 4_000 });
  assert.equal(first.input_checksum, replayed.input_checksum);
  // Audience data stays on the returned input so a stored diagnostic row can
  // still replay the low-audience prefilter rule.
  assert.equal(first.subscriber_count, 12);
  assert.equal(first.video_count, 3);
  assert.equal(replayed.subscriber_count, 900_000);
  assert.equal(replayed.video_count, 4_000);
});

test('normalization is idempotent when a stored row carries derived checksum keys', () => {
  const original = normalizeProductionDiagnosticInput({
    channel_name: 'Example Creator',
    description: 'Trading education',
    external_links: ['https://b.example', 'https://a.example'],
  });
  const replay = normalizeProductionDiagnosticInput(original as any);
  assert.equal(replay.input_checksum, original.input_checksum);
  assert.equal(replay.input_checksum_version, original.input_checksum_version);
});
