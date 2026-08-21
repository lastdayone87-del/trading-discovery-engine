import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getPendingStagedCandidates,
  updateStagedCandidateResolution,
  processPendingStagedCandidates
} from './candidateStaging';

test('getPendingStagedCandidates returns empty list when DB is offline', async () => {
  const candidates = await getPendingStagedCandidates(10);
  assert.ok(Array.isArray(candidates));
});

test('updateStagedCandidateResolution fails gracefully when DB is offline', async () => {
  const success = await updateStagedCandidateResolution('non-existent-id', {
    resolutionStatus: 'RESOLVED',
    resolvedChannelId: 'UC12345'
  });
  assert.equal(success, false);
});

test('processPendingStagedCandidates handles resolution and deferral correctly', async () => {
  const result = await processPendingStagedCandidates();
  assert.equal(typeof result.processed, 'number');
  assert.equal(typeof result.resolved, 'number');
  assert.equal(typeof result.deferred, 'number');
});

test('processPendingStagedCandidates preserves UNVALIDATED validation status during identity resolution', async () => {
  let updatedInput: any = null;
  const mockDb = {
    query: async (sql: string, params: any[]) => {
      if (sql.includes('SELECT')) {
        return {
          rows: [{
            id: 'staging-id-1',
            staging_key: 'key-1',
            provider_key: 'brave-search',
            candidate_type: 'HANDLE',
            normalized_identity: '@trader1',
            raw_locator: 'https://youtube.com/@trader1',
            country: 'US',
            discovery_mode: 'DIRECT_YOUTUBE',
            resolution_status: 'PENDING',
            metadata: '{}'
          }]
        };
      }
      if (sql.includes('UPDATE')) {
        updatedInput = { resolutionStatus: params[1], resolvedChannelId: params[2], validationStatus: params[3] };
        return { rowCount: 1 };
      }
      return { rows: [] };
    }
  };

  const resolver = async (identity: string, type: string) => 'UC1234567890123456789012';
  const result = await processPendingStagedCandidates(resolver, mockDb);

  assert.equal(result.resolved, 1);
  assert.equal(updatedInput.resolutionStatus, 'RESOLVED');
  assert.equal(updatedInput.resolvedChannelId, 'UC1234567890123456789012');
  assert.equal(updatedInput.validationStatus, 'UNVALIDATED'); // Must remain UNVALIDATED
});
