import test from 'node:test';
import assert from 'node:assert/strict';
import { retainedCreatorEvidenceInput } from './dryRunCountryAttribution';

test('dry-run creator evidence input contains no fabricated channel text', () => {
  const input = retainedCreatorEvidenceInput({
    channel_id: 'test',
    channel_name: 'India Trading Channel',
    country: 'Canada',
    country_status: 'UNCERTAIN',
    confidence_score: 25,
    country_metadata_status: 'AVAILABLE_NOT_DECLARED',
    inspection_trail: [{ step: 'COUNTRY_VALIDATION', details: 'Discovery context: Canada' }]
  } as never);
  assert.equal(input.channelName, '');
  assert.equal(input.description, '');
  assert.deepEqual(input.videoTitles, []);
  assert.deepEqual(input.externalLinks, []);
  assert.deepEqual(input.socialBios, []);
  assert.equal(input.metadataStatus, 'AVAILABLE_NOT_DECLARED');
});
